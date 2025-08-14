"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from "recharts";
import { Settings, RefreshCw } from "lucide-react";

// =====================================
// Constantes – baseline (editables vía UI)
// =====================================
const HOURS_PER_TURNO = 8;
const DAYS_5x2 = 5;       // lunes a viernes
const DAYS_6x2 = 7;       // cobertura 7 días (rotativo)
const FACTOR_DOT_6x2 = 8 / 6; // dotación total requerida para cubrir 7d con rotación 6x2

// Conversión por equipo (ml por m²), editable
const ML_PER_M2_BASE = { Bilateral: 2.8, CNC: 4.12, DVH: 3.2 } as const;

// DVH mix (sobre panes)
const DVH_MIX = { templado: 0.35, laminado: 0.60, float: 0.05 } as const;

// Metas diarias baseline (m²)
const METAS_D_BASE = { templado: 128, lamEspecial: 60, lamPulido: 44, lamCortado: 44, dvh: 800 } as const;

// Dotación BASE real (estado actual informado)
const BASE = {
  corte: {
    Jumbo: { sistema: "5x2" as const, turnos: 3, persTurno: 2 },
    H1:    { sistema: "5x2" as const, turnos: 3, persTurno: 2 },
    H2:    { sistema: "5x2" as const, turnos: 2, persTurno: 2 },
  },
  bordes: {
    Bil: { sistema: "5x2" as const, turnos: 3, persTurno: 2 },
    CNC: { sistema: "5x2" as const, turnos: 1, persTurno: 1 },
    DVH: { sistema: "5x2" as const, turnos: 1, persTurno: 3 },
  },
  glaston: { sistema: "5x2" as const, turnos: 3, persTurno: 8/3 },
  dvh:     { sistema: "5x2" as const, turnos: 2, persTurno: 5.5 },
  bovone:  { sistema: "6x2" as const, turnos: 3, persTurno: 3.5 },
} as const;

// =============================
// Helpers
// =============================
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const fmt = (n?: number, d: number = 0) => (n === undefined || !Number.isFinite(n) ? "-" : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const money = (n?: number) => (n === undefined || !Number.isFinite(n) ? "-" : n.toLocaleString(undefined, { style: "currency", currency: "ARS", maximumFractionDigits: 2 }));
const daysFor = (sistema: "5x2" | "6x2") => (sistema === "6x2" ? DAYS_6x2 : DAYS_5x2);
const dotFactor = (sistema: "5x2" | "6x2") => (sistema === "6x2" ? FACTOR_DOT_6x2 : 1);
const horasSemana = (turnos: number, sistema: "5x2" | "6x2", extra: number = 0) => turnos * HOURS_PER_TURNO * daysFor(sistema) + Math.max(0, extra);
// Días de mes equivalentes según sistema (≈ 4.33 semanas/mes)
const daysMonthFor = (sistema: "5x2" | "6x2") => daysFor(sistema) * 4.33;

// HH por semana (personales)
const hhSemana = (persTurno: number, turnos: number, sistema: "5x2" | "6x2", extra: number = 0) => persTurno * horasSemana(turnos, sistema, extra);

// Pill de alerta
const Pill: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-300">{children}</span>
);

// =============================
// Tests ligeros (en consola)
// =============================
function devSelfTests() {
  // Corte 5x2 3 turnos @56.25 m²/h → 56.25*8*3*5 = 6750 m²/sem
  const cap5x2 = 56.25 * horasSemana(3, "5x2", 0);
  console.assert(Math.round(cap5x2) === 6750, `cap 5x2 esperado 6750, obtuve ${cap5x2}`);
  // Corte 6x2 3 turnos @56.25 m²/h → 56.25*8*3*7 = 9450 m²/sem
  const cap6x2 = 56.25 * horasSemana(3, "6x2", 0);
  console.assert(Math.round(cap6x2) === 9450, `cap 6x2 esperado 9450, obtuve ${cap6x2}`);
  // Denominador Glaston
  const denom = 2 * DVH_MIX.templado * 15; // 10.5 kg/m² DVH
  console.assert(Math.abs(denom - 10.5) < 1e-9, `denominador Glaston 10.5 kg/m²`);
  // DVH acoplado: si cap cadena < meta, objetivo sigue la capacidad
  const meta = 800, cap = 600; const objetivo = Math.min(meta, Math.floor(cap));
  console.assert(objetivo === 600, `DVH acoplado esperado 600, obtuve ${objetivo}`);
  // Incorporaciones vs BASE: H2 pasa de 5x2 a 6x2 (2 pers/turno, 2 turnos)
  const curDot = 2*2*FACTOR_DOT_6x2; const baseDot = 2*2*1; const inc = Math.max(0, Math.ceil(curDot - baseDot));
  console.assert(inc === 2, `Inc H2 esperado 2, obtuve ${inc}`);
  const d5 = daysMonthFor("5x2"); console.assert(Math.abs(d5 - (5*4.33)) < 0.05, `mes 5x2 ~21.65, obtuve ${d5}`);
  const d6 = daysMonthFor("6x2"); console.assert(Math.abs(d6 - (7*4.33)) < 0.05, `mes 6x2 ~30.31, obtuve ${d6}`);
}
if (typeof window !== "undefined") { try { devSelfTests(); } catch (e) { console.warn(e); } }

// =============================
// Componente principal
// =============================
export default function App() {
  // ======= Parámetros económicos =======
  const [salarioMensual, setSalarioMensual] = useState(2874994.79); // ARS por operario/mes (cat 3)
  const [precioHoraExtra, setPrecioHoraExtra] = useState(10645);    // ARS por hora extra

  // ======= Metas & reglas =======
  const [metasD, setMetasD] = useState({ ...METAS_D_BASE });
  const [distMes, setDistMes] = useState(100_000);
  const [usarMermas, setUsarMermas] = useState(true);
  const [lamEspDesdeMono, setLamEspDesdeMono] = useState(true);
  const [modoAcoplado, setModoAcoplado] = useState(true);      // capea DVH por la capacidad
  const [autoDvhCap, setAutoDvhCap] = useState(false);         // hace que DVH siga a la capacidad

  // ======= Calendario de DEMANDA (global) =======
  // Define en cuántos días por semana/mes medimos la DEMANDA. La CAPACIDAD sigue el sistema de cada línea.
  const [calDemanda, setCalDemanda] = useState<"5x2"|"6x2">("5x2");
  const DEM_DAYS_WEEK = daysFor(calDemanda);
  const DEM_DAYS_MONTH = daysMonthFor(calDemanda);

  // ======= Bordes – ml/m² editables =======
  const [mlPerM2, setMlPerM2] = useState({ ...ML_PER_M2_BASE });
  const [bordesVistaMl, setBordesVistaMl] = useState(true);    // true = ml, false = m²

  // ======= Corte (tasa m²/h, pers/turno, turnos, sistema, extra) =======
  const [corte, setCorte] = useState({
    Jumbo:  { tasa: 56.25, sistema: "5x2" as const, turnos: 3, persTurno: 2, extra: 0 },
    H1:     { tasa: 26.325, sistema: "5x2" as const, turnos: 3, persTurno: 2, extra: 0 },
    H2:     { tasa: 26.325, sistema: "5x2" as const, turnos: 2, persTurno: 2, extra: 0 },
  });

  // ======= Bordes (tasa ml/h...) =======
  const [bordes, setBordes] = useState({
    Bil:   { tasa: 3500 / 24, sistema: "5x2" as const, turnos: 3, persTurno: 2, extra: 0 },
    CNC:   { tasa: 213 / 8,   sistema: "5x2" as const, turnos: 1, persTurno: 1, extra: 0 },
    DVH:   { tasa: 600 / 8,   sistema: "5x2" as const, turnos: 1, persTurno: 3, extra: 0 },
  });

  // ======= Glaston (kg/h...) =======
  const [glaston, setGlaston] = useState({ tasa: 16000 / 24, sistema: "5x2" as const, turnos: 3, persTurno: 8/3, extra: 0 });

  // ======= DVH armado (m²/h...) =======
  // baseline: 800 m²/d con 2 turnos → 800/16 = 50 m²/h
  const [dvh, setDvh] = useState({ tasa: 50, sistema: "5x2" as const, turnos: 2, persTurno: 5.5, extra: 0 });

  // ======= Bovone (m²/h...) =======
  // baseline real informado: Personal 14, Turnos 3, sistema 6×2 ⇒ pers/turno = 14 / (3 * 8/6) = 3.5
  const [bovone, setBovone] = useState({ tasa: (72000 / 17) / 24, sistema: "6x2" as const, turnos: 3, persTurno: 3.5, extra: 0 });

  // =============================
  // Capacidades por área (dependen de tasa, turnos, sistema, extra)
  // =============================
  const capJumboSem = useMemo(() => corte.Jumbo.tasa * horasSemana(corte.Jumbo.turnos, corte.Jumbo.sistema, corte.Jumbo.extra), [corte.Jumbo]);
  const capH1Sem    = useMemo(() => corte.H1.tasa    * horasSemana(corte.H1.turnos, corte.H1.sistema, corte.H1.extra), [corte.H1]);
  const capH2Sem    = useMemo(() => corte.H2.tasa    * horasSemana(corte.H2.turnos, corte.H2.sistema, corte.H2.extra), [corte.H2]);
  const capHeglasSem = capH1Sem + capH2Sem;
  const capJumboDia = capJumboSem / daysFor(corte.Jumbo.sistema);
  const capH1Dia = capH1Sem / daysFor(corte.H1.sistema);
  const capH2Dia = capH2Sem / daysFor(corte.H2.sistema);
  const capHeglasDia = capH1Dia + capH2Dia; // corrige caso H1/H2 con sistemas distintos

  const capBilMlSem = useMemo(() => bordes.Bil.tasa * horasSemana(bordes.Bil.turnos, bordes.Bil.sistema, bordes.Bil.extra), [bordes.Bil]);
  const capCncMlSem = useMemo(() => bordes.CNC.tasa * horasSemana(bordes.CNC.turnos, bordes.CNC.sistema, bordes.CNC.extra), [bordes.CNC]);
  const capDvhMlSem = useMemo(() => bordes.DVH.tasa * horasSemana(bordes.DVH.turnos, bordes.DVH.sistema, bordes.DVH.extra), [bordes.DVH]);
  const capBilM2Sem = capBilMlSem / mlPerM2.Bilateral;
  const capCncM2Sem = capCncMlSem / mlPerM2.CNC;
  const capDvhM2Sem = capDvhMlSem / mlPerM2.DVH;
  const capBordesM2Sem = capBilM2Sem + capCncM2Sem + capDvhM2Sem;
  const capBordesDia = capBordesM2Sem / daysFor(bordes.Bil.sistema);

  const glastonCapSemKg = useMemo(() => glaston.tasa * horasSemana(glaston.turnos, glaston.sistema, glaston.extra), [glaston]);
  const glastonCapDiaKg = glastonCapSemKg / daysFor(glaston.sistema);

  const dvhCapSemM2 = useMemo(() => dvh.tasa * horasSemana(dvh.turnos, dvh.sistema, dvh.extra), [dvh]);
  const dvhCapDiaM2 = dvhCapSemM2 / daysFor(dvh.sistema);

  const bovoneCapSemM2 = useMemo(() => bovone.tasa * horasSemana(bovone.turnos, bovone.sistema, bovone.extra), [bovone]);
  const bovoneCapDiaM2 = bovoneCapSemM2 / daysFor(bovone.sistema);
  const daysMesBov = daysMonthFor(bovone.sistema);
  const bovoneCapMesM2 = bovoneCapDiaM2 * daysMesBov;

  // =============================
  // DVH máximo alcanzable por cadena (m²/día)
  // =============================
  const disponibleMonoParaDVH = Math.max(0, capJumboDia - (metasD.templado + (lamEspDesdeMono ? metasD.lamEspecial * 2 : 0)));
  const dvhMaxPorJumbo = disponibleMonoParaDVH / 0.8;

  const otrosLamHeglas = (lamEspDesdeMono ? 0 : metasD.lamEspecial) + metasD.lamPulido + metasD.lamCortado;
  const disponibleLamParaDVH = Math.max(0, capHeglasDia - otrosLamHeglas);
  const dvhMaxPorHeglas = disponibleLamParaDVH / 1.2;

  const glastonOtrasCargasKg = metasD.templado * 20 + (metasD.lamEspecial * 2) * 18;
  const glastonDispParaDVHkg = Math.max(0, glastonCapDiaKg - glastonOtrasCargasKg);
  const dvhMaxPorGlaston = glastonDispParaDVHkg / (2 * DVH_MIX.templado * 15);

  const otrosBordes = metasD.templado + metasD.lamEspecial + metasD.lamPulido;
  const dispBordesParaDVH = Math.max(0, capBordesDia - otrosBordes);
  const dvhMaxPorBordes = dispBordesParaDVH / 2;

  const otrosBovone = metasD.lamEspecial + metasD.lamPulido + metasD.lamCortado + distMes / DEM_DAYS_MONTH;
  const dispBovoneParaDVH = Math.max(0, bovoneCapDiaM2 - otrosBovone);
  const dvhMaxPorBovone = dispBovoneParaDVH / 1.2;

  const dvhMaxPorArmado = dvhCapDiaM2;
  const dvhMaxCadenaDia = Math.max(0, Math.min(
    dvhMaxPorJumbo,
    dvhMaxPorHeglas,
    dvhMaxPorGlaston,
    dvhMaxPorBordes,
    dvhMaxPorBovone,
    dvhMaxPorArmado,
  ));

  // Objetivo DVH a usar en cálculos de demanda
  let dvhObjetivo = metasD.dvh;
  if (autoDvhCap) dvhObjetivo = Math.floor(dvhMaxCadenaDia); // sigue la capacidad
  else if (modoAcoplado) dvhObjetivo = Math.min(metasD.dvh, Math.floor(dvhMaxCadenaDia)); // capea por capacidad

  // =============================
  // Demandas derivadas (usando dvhObjetivo)
  // =============================
  const dvhPanesDia = dvhObjetivo * 2;
  const dvhTempladoDia = dvhPanesDia * DVH_MIX.templado;
  const dvhLaminadoDia = dvhPanesDia * DVH_MIX.laminado;

  // Corte neto
  const corteMonoDia = metasD.templado + (lamEspDesdeMono ? metasD.lamEspecial * 2 : 0) + dvhTempladoDia + (dvhPanesDia * DVH_MIX.float);
  const corteLamDia = (lamEspDesdeMono ? 0 : metasD.lamEspecial) + metasD.lamPulido + metasD.lamCortado + dvhLaminadoDia;
  const corteMonoSem = corteMonoDia * DEM_DAYS_WEEK;
  const corteLamSem = corteLamDia * DEM_DAYS_WEEK;

  // Mermas a consumo (solo cálculo de consumo bruto, no capacidad)
  const corteMonoDiaBruto = usarMermas ? corteMonoDia * 1.18 : corteMonoDia;
  const corteLamDiaBruto = usarMermas ? corteLamDia * 1.30 : corteLamDia;

  // Bordes – m²
  const bordesM2Dia = metasD.templado + metasD.lamEspecial + metasD.lamPulido + dvhPanesDia;
  const bordesM2Sem = bordesM2Dia * DEM_DAYS_WEEK;

  // Glaston – kg
  const glastonKgDia = dvhTempladoDia * 15 + metasD.templado * 20 + (metasD.lamEspecial * 2) * 18;
  const glastonKgSem = glastonKgDia * DEM_DAYS_WEEK;

  // Bovone – m²/mes (producción) + distribución
  const prodLamMes = (dvhLaminadoDia + metasD.lamPulido + metasD.lamCortado + metasD.lamEspecial) * DEM_DAYS_MONTH;
  const bovoneDemMes = prodLamMes + distMes;

  // =============================
  // Brechas & faltantes (negativo = déficit)
  // =============================
  const brechaJumbo = capJumboSem - corteMonoSem;
  const brechaHeglas = capHeglasSem - corteLamSem;
  const brechaBordesM2 = capBordesM2Sem - bordesM2Sem;
  const brechaGlaston = glastonCapSemKg - glastonKgSem;
  const brechaDvh = dvhCapSemM2 - dvhObjetivo * DEM_DAYS_WEEK;
  const brechaBovoneMes = bovoneCapMesM2 - bovoneDemMes;

  const faltanteJumbo = Math.max(0, corteMonoSem - capJumboSem);
  const faltanteHeglas = Math.max(0, corteLamSem - capHeglasSem);
  const faltanteBordesM2 = Math.max(0, bordesM2Sem - capBordesM2Sem);
  const faltanteGlaston = Math.max(0, glastonKgSem - glastonCapSemKg);
  const faltanteDvh = Math.max(0, dvhObjetivo * DEM_DAYS_WEEK - dvhCapSemM2);
  const faltanteBovoneMes = Math.max(0, bovoneDemMes - bovoneCapMesM2);

  // También expresar bordes en ml (para alerta)
  const repartoBil = bordesM2Sem * (capBilM2Sem / capBordesM2Sem || 0);
  const repartoCnc = bordesM2Sem * (capCncM2Sem / capBordesM2Sem || 0);
  const repartoDvh = bordesM2Sem * (capDvhM2Sem / capBordesM2Sem || 0);
  const demBilMl = Math.round(repartoBil * mlPerM2.Bilateral);
  const demCncMl = Math.round(repartoCnc * mlPerM2.CNC);
  const demDvhMl = Math.round(repartoDvh * mlPerM2.DVH);
  const demandaBordesMlTotal = demBilMl + demCncMl + demDvhMl;
  const capacidadBordesMlTotal = Math.round(capBilMlSem + capCncMlSem + capDvhMlSem);
  const brechaBordesMl = capacidadBordesMlTotal - demandaBordesMlTotal;
  const faltanteBordesMl = Math.max(0, demandaBordesMlTotal - capacidadBordesMlTotal);

  // Faltantes por línea (para mostrar en el título del sector)
  const faltBilMl = Math.max(0, demBilMl - Math.round(capBilMlSem));
  const faltCncMl = Math.max(0, demCncMl - Math.round(capCncMlSem));
  const faltFdvMl = Math.max(0, demDvhMl - Math.round(capDvhMlSem));
  const faltBilM2 = Math.max(0, Math.round(repartoBil - capBilM2Sem));
  const faltCncM2 = Math.max(0, Math.round(repartoCnc - capCncM2Sem));
  const faltFdvM2 = Math.max(0, Math.round(repartoDvh - capDvhM2Sem));

  // Quick flags para resaltar tarjetas
  const needCorte = brechaJumbo < 0 || brechaHeglas < 0;
  const needBordes = brechaBordesM2 < 0; // criterio principal por m²
  const needGlaston = brechaGlaston < 0;
  const needDvh = brechaDvh < 0;
  const needBovone = brechaBovoneMes < 0;

  // =============================
  // Costos – dotación total requerida y horas extra (mensualizadas)
  // =============================
  const weeksPerMonth = 4.33;
  const dotJumbo = corte.Jumbo.persTurno * corte.Jumbo.turnos * dotFactor(corte.Jumbo.sistema);
  const dotH1 = corte.H1.persTurno * corte.H1.turnos * dotFactor(corte.H1.sistema);
  const dotH2 = corte.H2.persTurno * corte.H2.turnos * dotFactor(corte.H2.sistema);
  const dotBil = bordes.Bil.persTurno * bordes.Bil.turnos * dotFactor(bordes.Bil.sistema);
  const dotCnc = bordes.CNC.persTurno * bordes.CNC.turnos * dotFactor(bordes.CNC.sistema);
  const dotDvhB = bordes.DVH.persTurno * bordes.DVH.turnos * dotFactor(bordes.DVH.sistema);
  const dotGlast = glaston.persTurno * glaston.turnos * dotFactor(glaston.sistema);
  const dotDvh = dvh.persTurno * dvh.turnos * dotFactor(dvh.sistema);
  const dotBov = bovone.persTurno * bovone.turnos * dotFactor(bovone.sistema);
  const dotTotal = dotJumbo + dotH1 + dotH2 + dotBil + dotCnc + dotDvhB + dotGlast + dotDvh + dotBov;

  const extraCost = (persTurno: number, turnos: number, horas: number) => persTurno * turnos * Math.max(0, horas) * weeksPerMonth * precioHoraExtra;
  const baseCost = (dot: number) => dot * salarioMensual;

  const costos = {
    Jumbo: { base: baseCost(dotJumbo), extra: extraCost(corte.Jumbo.persTurno, corte.Jumbo.turnos, corte.Jumbo.extra) },
    Hegla1:{ base: baseCost(dotH1),   extra: extraCost(corte.H1.persTurno, corte.H1.turnos, corte.H1.extra) },
    Hegla2:{ base: baseCost(dotH2),   extra: extraCost(corte.H2.persTurno, corte.H2.turnos, corte.H2.extra) },
    Bil:   { base: baseCost(dotBil),  extra: extraCost(bordes.Bil.persTurno, bordes.Bil.turnos, bordes.Bil.extra) },
    CNC:   { base: baseCost(dotCnc),  extra: extraCost(bordes.CNC.persTurno, bordes.CNC.turnos, bordes.CNC.extra) },
    FDVH:  { base: baseCost(dotDvhB), extra: extraCost(bordes.DVH.persTurno, bordes.DVH.turnos, bordes.DVH.extra) },
    Glast: { base: baseCost(dotGlast),extra: extraCost(glaston.persTurno, glaston.turnos, glaston.extra) },
    ArmDVH:{ base: baseCost(dotDvh),  extra: extraCost(dvh.persTurno, dvh.turnos, dvh.extra) },
    Bovone:{ base: baseCost(dotBov),  extra: extraCost(bovone.persTurno, bovone.turnos, bovone.extra) },
  } as const;
  const costoTotalBase = Object.values(costos).reduce((a,c)=>a+c.base,0);
  const costoTotalExtra = Object.values(costos).reduce((a,c)=>a+c.extra,0);
  const costoTotal = costoTotalBase + costoTotalExtra;

  // === INCORPORACIONES requeridas vs DOTACIÓN BASE REAL ===
  const baseDot = {
    Jumbo: BASE.corte.Jumbo.persTurno * BASE.corte.Jumbo.turnos * dotFactor(BASE.corte.Jumbo.sistema),
    H1:    BASE.corte.H1.persTurno    * BASE.corte.H1.turnos    * dotFactor(BASE.corte.H1.sistema),
    H2:    BASE.corte.H2.persTurno    * BASE.corte.H2.turnos    * dotFactor(BASE.corte.H2.sistema),
    Bil:   BASE.bordes.Bil.persTurno  * BASE.bordes.Bil.turnos  * dotFactor(BASE.bordes.Bil.sistema),
    CNC:   BASE.bordes.CNC.persTurno  * BASE.bordes.CNC.turnos  * dotFactor(BASE.bordes.CNC.sistema),
    FDVH:  BASE.bordes.DVH.persTurno  * BASE.bordes.DVH.turnos  * dotFactor(BASE.bordes.DVH.sistema),
    Glast: BASE.glaston.persTurno     * BASE.glaston.turnos     * dotFactor(BASE.glaston.sistema),
    Arm:   BASE.dvh.persTurno         * BASE.dvh.turnos         * dotFactor(BASE.dvh.sistema),
    Bov:   BASE.bovone.persTurno      * BASE.bovone.turnos      * dotFactor(BASE.bovone.sistema),
  } as const;

  const inc = {
    Jumbo:  Math.max(0, Math.ceil(dotJumbo - baseDot.Jumbo)),
    Hegla1: Math.max(0, Math.ceil(dotH1   - baseDot.H1)),
    Hegla2: Math.max(0, Math.ceil(dotH2   - baseDot.H2)),
    Bil:    Math.max(0, Math.ceil(dotBil  - baseDot.Bil)),
    CNC:    Math.max(0, Math.ceil(dotCnc  - baseDot.CNC)),
    FDVH:   Math.max(0, Math.ceil(dotDvhB - baseDot.FDVH)),
    Glast:  Math.max(0, Math.ceil(dotGlast- baseDot.Glast)),
    ArmDVH: Math.max(0, Math.ceil(dotDvh  - baseDot.Arm)),
    Bovone: Math.max(0, Math.ceil(dotBov  - baseDot.Bov)),
  } as const;
  const incCost = {
    Jumbo: inc.Jumbo * salarioMensual,
    Hegla1:inc.Hegla1 * salarioMensual,
    Hegla2:inc.Hegla2 * salarioMensual,
    Bil:   inc.Bil * salarioMensual,
    CNC:   inc.CNC * salarioMensual,
    FDVH:  inc.FDVH * salarioMensual,
    Glast: inc.Glast * salarioMensual,
    ArmDVH:inc.ArmDVH * salarioMensual,
    Bovone:inc.Bovone * salarioMensual,
  } as const;
  const incTotalOps = Object.values(inc).reduce((a,b)=>a+b,0);
  const incTotalCost = Object.values(incCost).reduce((a,b)=>a+b,0);

  // =============================
  // Gráficos datasets
  // =============================
  const dataCorte = [
    { linea: "Jumbo", Capacidad: Math.round(capJumboSem), Demanda_OK: Math.round(Math.min(corteMonoSem, capJumboSem)), Exceso: Math.round(Math.max(corteMonoSem - capJumboSem, 0)) },
    { linea: "Heglas", Capacidad: Math.round(capHeglasSem), Demanda_OK: Math.round(Math.min(corteLamSem, capHeglasSem)), Exceso: Math.round(Math.max(corteLamSem - capHeglasSem, 0)) },
  ];
  const dataBilMl = [ { linea: "Bilateral", Capacidad: Math.round(capBilMlSem), Demanda_OK: Math.min(demBilMl, Math.round(capBilMlSem)), Exceso: Math.max(demBilMl - Math.round(capBilMlSem), 0) } ];
  const dataCncMl = [ { linea: "Forel CNC", Capacidad: Math.round(capCncMlSem), Demanda_OK: Math.min(demCncMl, Math.round(capCncMlSem)), Exceso: Math.max(demCncMl - Math.round(capCncMlSem), 0) } ];
  const dataDvhMl = [ { linea: "Forel DVH", Capacidad: Math.round(capDvhMlSem), Demanda_OK: Math.min(demDvhMl, Math.round(capDvhMlSem)), Exceso: Math.max(demDvhMl - Math.round(capDvhMlSem), 0) } ];
  const dataBilM2 = [ { linea: "Bilateral", Capacidad: Math.round(capBilM2Sem), Demanda_OK: Math.round(Math.min(repartoBil, capBilM2Sem)), Exceso: Math.round(Math.max(repartoBil - capBilM2Sem, 0)) } ];
  const dataCncM2 = [ { linea: "Forel CNC", Capacidad: Math.round(capCncM2Sem), Demanda_OK: Math.round(Math.min(repartoCnc, capCncM2Sem)), Exceso: Math.round(Math.max(repartoCnc - capCncM2Sem, 0)) } ];
  const dataDvhM2 = [ { linea: "Forel DVH", Capacidad: Math.round(capDvhM2Sem), Demanda_OK: Math.round(Math.min(repartoDvh, capDvhM2Sem)), Exceso: Math.round(Math.max(repartoDvh - capDvhM2Sem, 0)) } ];
  const dataGlaston = [ { linea: "Glaston", Capacidad: Math.round(glastonCapSemKg), Demanda_OK: Math.round(Math.min(glastonKgSem, glastonCapSemKg)), Exceso: Math.round(Math.max(glastonKgSem - glastonCapSemKg, 0)) } ];
  const dataDvh = [ { linea: "DVH armado", Capacidad: Math.round(dvhCapSemM2), Demanda_OK: Math.round(Math.min(dvhObjetivo * DEM_DAYS_WEEK, dvhCapSemM2)), Exceso: Math.round(Math.max(dvhObjetivo * DEM_DAYS_WEEK - dvhCapSemM2, 0)) } ];
  const dataBovone = [ { mes: "Mes", Capacidad: Math.round(bovoneCapMesM2), Demanda_OK: Math.round(Math.min(bovoneDemMes, bovoneCapMesM2)), Exceso: Math.round(Math.max(bovoneDemMes - bovoneCapMesM2, 0)) } ];
  const dataCostos = [
    { area: "Jumbo", Base: costos.Jumbo.base, Extra: costos.Jumbo.extra },
    { area: "Hegla 1", Base: costos.Hegla1.base, Extra: costos.Hegla1.extra },
    { area: "Hegla 2", Base: costos.Hegla2.base, Extra: costos.Hegla2.extra },
    { area: "Bilateral", Base: costos.Bil.base, Extra: costos.Bil.extra },
    { area: "Forel CNC", Base: costos.CNC.base, Extra: costos.CNC.extra },
    { area: "Forel DVH", Base: costos.FDVH.base, Extra: costos.FDVH.extra },
    { area: "Glaston", Base: costos.Glast.base, Extra: costos.Glast.extra },
    { area: "DVH armado", Base: costos.ArmDVH.base, Extra: costos.ArmDVH.extra },
    { area: "Bovone", Base: costos.Bovone.base, Extra: costos.Bovone.extra },
  ];

  // ======= Optimizador (horas extra mínimas) – como antes =======
  const [autoAjuste, setAutoAjuste] = useState(false);
  const [logAjuste, setLogAjuste] = useState("");
  const autoRuns = useRef(0);
  function sugerirYAplicarAjustes(auto=false){
    const cambios:string[]=[];
    if(brechaJumbo<0){ const need = -brechaJumbo; const addH = Math.ceil(need / corte.Jumbo.tasa); setCorte(s=>({...s, Jumbo:{...s.Jumbo, extra:s.Jumbo.extra+addH}})); cambios.push(`Jumbo +${addH} h/sem`);}    
    if(brechaHeglas<0){ const need=-brechaHeglas; const addH=Math.ceil(need/(corte.H1.tasa+corte.H2.tasa)); const addH1=Math.ceil(addH/2), addH2=Math.floor(addH/2); setCorte(s=>({...s,H1:{...s.H1,extra:s.H1.extra+addH1},H2:{...s.H2,extra:s.H2.extra+addH2}})); cambios.push(`Heglas +${addH1}+${addH2} h/sem`);}    
    if(brechaBordesM2<0){ let rem=-brechaBordesM2; const rates=[{k:"Bil",v:bordes.Bil.tasa/mlPerM2.Bilateral},{k:"CNC",v:bordes.CNC.tasa/mlPerM2.CNC},{k:"DVH",v:bordes.DVH.tasa/mlPerM2.DVH}].sort((a,b)=>b.v-a.v); let B={...bordes}; for(const r of rates){ if(rem<=0)break; const addH=Math.ceil(rem/r.v); // todo a horas extra
      // @ts-ignore
      B[r.k].extra += addH; rem=0; cambios.push(`Bordes ${r.k} +${addH} h/sem`);} setBordes(B); }
    if(brechaGlaston<0){ const need=-brechaGlaston; const addH=Math.ceil(need/glaston.tasa); setGlaston(s=>({...s, extra:s.extra+addH})); cambios.push(`Glaston +${addH} h/sem`);}    
    if(brechaDvh<0){ const need=-brechaDvh; const tasaNueva=(dvhCapSemM2+need)/horasSemana(dvh.turnos,dvh.sistema,dvh.extra); setDvh(s=>({...s, tasa: tasaNueva})); cambios.push(`DVH arma +${Math.ceil(need / daysFor(dvh.sistema))} m²/d eq.`);}    
    if(brechaBovoneMes<0){ const needDay=Math.ceil((-brechaBovoneMes)/30); const tasaNueva=(bovoneCapDiaM2+needDay)/(horasSemana(bovone.turnos,bovone.sistema,bovone.extra)/daysFor(bovone.sistema)); setBovone(s=>({...s,tasa:tasaNueva})); cambios.push(`Bovone +${needDay} m²/d eq.`);}    
    if(cambios.length) setLogAjuste((auto?"[Auto] ":"")+cambios.join(" · "));
  }
  useEffect(()=>{ if(!autoAjuste){autoRuns.current=0;return;} const any=brechaJumbo<0||brechaHeglas<0||brechaBordesM2<0||brechaGlaston<0||brechaDvh<0||brechaBovoneMes<0; if(any&&autoRuns.current<3){autoRuns.current++; sugerirYAplicarAjustes(true);} },[autoAjuste,brechaJumbo,brechaHeglas,brechaBordesM2,brechaGlaston,brechaDvh,brechaBovoneMes]);

  function reset(){
    setSalarioMensual(2874994.79); setPrecioHoraExtra(10645);
    setMetasD({ ...METAS_D_BASE }); setDistMes(100_000); setUsarMermas(true); setLamEspDesdeMono(true); setModoAcoplado(true); setAutoDvhCap(false); setMlPerM2({ ...ML_PER_M2_BASE }); setBordesVistaMl(true);
    setCorte({ Jumbo:{tasa:56.25,sistema:"5x2",turnos:3,persTurno:2,extra:0}, H1:{tasa:26.325,sistema:"5x2",turnos:3,persTurno:2,extra:0}, H2:{tasa:26.325,sistema:"5x2",turnos:2,persTurno:2,extra:0} });
    setBordes({ Bil:{tasa:3500/24,sistema:"5x2",turnos:3,persTurno:2,extra:0}, CNC:{tasa:213/8,sistema:"5x2",turnos:1,persTurno:1,extra:0}, DVH:{tasa:600/8,sistema:"5x2",turnos:1,persTurno:3,extra:0} });
    setGlaston({ tasa:16000/24, sistema:"5x2", turnos:3, persTurno:8/3, extra:0 });
    setDvh({ tasa:50, sistema:"5x2", turnos:2, persTurno:5.5, extra:0 });
    setBovone({ tasa:(72000/17)/24, sistema:"6x2", turnos:3, persTurno:3.5, extra:0 });
    setAutoAjuste(false); setLogAjuste(""); autoRuns.current=0;
  }

  const Brecha = ({ value, unidad }: { value: number, unidad: string }) => (
    <span className={value >= 0 ? "text-emerald-600 font-medium" : "text-red-600 font-semibold"}>
      {value >= 0 ? `+${fmt(value)}` : `-${fmt(Math.abs(value))}`} {unidad}
    </span>
  );
  const StackChart = ({ data, xKey }: { data: any[], xKey: string }) => (
    <ResponsiveContainer>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xKey} />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey="Capacidad" fill="#cbd5e1" />
        <Bar dataKey="Demanda_OK" stackId="a" fill="#82ca9d" />
        <Bar dataKey="Exceso" stackId="a" fill="#ef4444" />
      </BarChart>
    </ResponsiveContainer>
  );

  // Componente de control por línea (reutilizable)
  function LineCtrl<T extends { tasa:number, sistema:"5x2"|"6x2", turnos:number, persTurno:number, extra:number }>(
    props:{title:string, unit:string, state:T, onChange:(v:T)=>void}
  ){
    const {title, unit, state, onChange} = props;
    const horas = horasSemana(state.turnos, state.sistema, state.extra);
    const dot = state.persTurno * state.turnos * dotFactor(state.sistema);
    const perTurnCrew = state.sistema === "6x2" ? FACTOR_DOT_6x2 : 1; // crews por turno
    const crewsExact = perTurnCrew * state.turnos; // crews totales para cubrir los turnos
    const crewsSugg = Math.ceil(crewsExact); // sugerencia operativa (entera)
    return (
      <div className="space-y-2">
        <div className="text-sm font-medium flex items-center gap-2">{title}</div>
        <div className="grid grid-cols-5 gap-2">
          <div>
            <label className="text-xs text-gray-600">Sistema</label>
            <select className="w-full border rounded-md h-9 px-2" value={state.sistema} onChange={(e)=>onChange({...state, sistema:(e.target.value as any)})}>
              <option value="5x2">5×2</option>
              <option value="6x2">6×2</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Tasa ({unit}/h)</label>
            <Input type="number" value={state.tasa} onChange={(e)=>onChange({...state, tasa:Number(e.target.value||0)})}/>
          </div>
          <div>
            <label className="text-xs text-gray-600">Turnos (1–3)</label>
            <Input type="number" value={state.turnos} onChange={(e)=>onChange({...state, turnos:clamp(Number(e.target.value||0),1,3)})}/>
          </div>
          <div>
            <label className="text-xs text-gray-600">Pers/turno</label>
            <Input type="number" step="0.1" value={state.persTurno} onChange={(e)=>onChange({...state, persTurno:Math.max(0,Number(e.target.value||0))})}/>
          </div>
          <div>
            <label className="text-xs text-gray-600">Horas extra/sem</label>
            <Input type="number" value={state.extra} onChange={(e)=>onChange({...state, extra:Math.max(0,Number(e.target.value||0))})}/>
          </div>
        </div>
        <div className="text-xs text-gray-600">Horas/sem {fmt(horas)} · Dotación total requerida <b>{fmt(dot,2)}</b> op</div>
        {state.sistema==="6x2" && (
          <div className="text-xs text-amber-700">Cuadrillas requeridas: {fmt(crewsExact,2)} ({fmt(perTurnCrew,3)} por turno) · Sugerido: <b>{crewsSugg}</b> cuadrilla{crewsSugg>1?"s":""}</div>
        )}
        {state.sistema==="6x2" && state.turnos===3 && (<div className="text-xs text-amber-700">6×2 con 3 turnos ⇒ requiere <b>4° turno</b> rotativo (dot = pers/turno × 4).</div>)}
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-10 bg-gradient-to-b from-gray-50 to-white">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Aplicación Producción – Simulador Interactivo</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={reset} className="gap-2"><RefreshCw className="w-4 h-4"/>Reset baseline</Button>
        </div>
      </div>

      {/* PARÁMETROS GENERALES */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Settings className="w-5 h-5"/> Parámetros generales</CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-5 gap-4">
          <div>
            <label className="text-xs text-gray-600">Distribución (m²/mes)</label>
            <Input type="number" value={distMes} onChange={(e) => setDistMes(Number(e.target.value || 0))} />
          </div>
          <div>
            <label className="text-xs text-gray-600">Salario mensual operario (ARS)</label>
            <Input type="number" value={salarioMensual} onChange={(e)=>setSalarioMensual(Number(e.target.value||0))} />
          </div>
          <div>
            <label className="text-xs text-gray-600">Precio hora extra (ARS)</label>
            <Input type="number" value={precioHoraExtra} onChange={(e)=>setPrecioHoraExtra(Number(e.target.value||0))} />
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={usarMermas} onCheckedChange={setUsarMermas} />
            <span className="text-sm">Aplicar mermas corte (+18% mono, +30% lam)</span>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={lamEspDesdeMono} onCheckedChange={setLamEspDesdeMono} />
            <span className="text-sm">Lam. especial desde monolítico (2 panes)</span>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={modoAcoplado} onCheckedChange={setModoAcoplado} />
            <span className="text-sm">Capea DVH por capacidad de cadena</span>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={autoDvhCap} onCheckedChange={setAutoDvhCap} />
            <span className="text-sm">DVH automático (sigue capacidad)</span>
          </div>
          <div>
            <label className="text-xs text-gray-600">Meta Templado (m²/d)</label>
            <Input type="number" value={metasD.templado} onChange={(e) => setMetasD((m) => ({ ...m, templado: Number(e.target.value || 0) }))} />
          </div>
          <div className="grid grid-cols-4 gap-2 col-span-full">
            <div>
              <label className="text-xs text-gray-600">Lam. especial</label>
              <Input type="number" value={metasD.lamEspecial} onChange={(e) => setMetasD((m) => ({ ...m, lamEspecial: Number(e.target.value || 0) }))} />
            </div>
            <div>
              <label className="text-xs text-gray-600">Lam. pulido</label>
              <Input type="number" value={metasD.lamPulido} onChange={(e) => setMetasD((m) => ({ ...m, lamPulido: Number(e.target.value || 0) }))} />
            </div>
            <div>
              <label className="text-xs text-gray-600">Lam. cortado</label>
              <Input type="number" value={metasD.lamCortado} onChange={(e) => setMetasD((m) => ({ ...m, lamCortado: Number(e.target.value || 0) }))} />
            </div>
            <div>
              <label className="text-xs text-gray-600">DVH (m²/d)</label>
              <Input type="number" value={metasD.dvh} onChange={(e) => setMetasD((m) => ({ ...m, dvh: Number(e.target.value || 0) }))} />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600">Calendario de demanda (para metas y consumo)</label>
            <select className="w-full border rounded-md h-9 px-2" value={calDemanda} onChange={(e)=>setCalDemanda(e.target.value as any)}>
              <option value="5x2">5×2 (L–V)</option>
              <option value="6x2">6×2 (7 días)</option>
            </select>
          </div>
          <div className="col-span-full text-xs text-gray-600">Objetivo DVH usado: <b>{fmt(dvhObjetivo)}</b> m²/d · Tope cadena {fmt(dvhMaxCadenaDia)} m²/d · Demanda semanal calculada con <b>{calDemanda}</b>.</div>
        </CardContent>
      </Card>

      {/* CORTE */}
      <Card className={`mb-6 ${needCorte ? 'ring-2 ring-red-400' : ''}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Corte – Capacidad vs Demanda (semanal) {needCorte && (<><Pill>⚠ Necesita ajuste</Pill>{faltanteJumbo>0 && <Pill>Jumbo: {fmt(faltanteJumbo)} m²/sem</Pill>}{faltanteHeglas>0 && <Pill>Heglas: {fmt(faltanteHeglas)} m²/sem</Pill>}</>) }</CardTitle>
        </CardHeader>
        <CardContent>
          {needCorte && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 text-sm p-2">
              {faltanteJumbo>0 && <div><b>Jumbo:</b> faltan {fmt(faltanteJumbo)} m²/sem</div>}
              {faltanteHeglas>0 && <div><b>Heglas:</b> faltan {fmt(faltanteHeglas)} m²/sem</div>}
            </div>
          )}
          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <LineCtrl title="Jumbo" unit="m²" state={corte.Jumbo} onChange={(v)=>setCorte(s=>({...s,Jumbo:v}))} />
            <LineCtrl title="Hegla 1" unit="m²" state={corte.H1} onChange={(v)=>setCorte(s=>({...s,H1:v}))} />
            <LineCtrl title="Hegla 2" unit="m²" state={corte.H2} onChange={(v)=>setCorte(s=>({...s,H2:v}))} />
          </div>
          <div className="h-64"><StackChart data={dataCorte} xKey="linea" /></div>
          <div className="mt-3 text-sm">Brecha Jumbo: <Brecha value={brechaJumbo} unidad="m²/sem"/> · Brecha Heglas: <Brecha value={brechaHeglas} unidad="m²/sem"/></div>
          <div className="text-xs text-gray-500 mt-1">Consumo de corte (neta): monolítico {fmt(corteMonoDia)} m²/d · laminado {fmt(corteLamDia)} m²/d {usarMermas && (<em>(bruto mono {fmt(corteMonoDiaBruto)} · lam {fmt(corteLamDiaBruto)} m²/d)</em>)}.</div>
        </CardContent>
      </Card>

      {/* BORDES */}
      <Card className={`mb-6 ${needBordes ? 'ring-2 ring-red-400' : ''}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Tratamiento de bordes – Capacidad vs Demanda {needBordes && (<><Pill>⚠ Necesita ajuste</Pill>{(bordesVistaMl ? faltBilMl : faltBilM2)>0 && <Pill>Bil: {fmt(bordesVistaMl?faltBilMl:faltBilM2)} {bordesVistaMl?'ml/sem':'m²/sem'}</Pill>}{(bordesVistaMl ? faltCncMl : faltCncM2)>0 && <Pill>CNC: {fmt(bordesVistaMl?faltCncMl:faltCncM2)} {bordesVistaMl?'ml/sem':'m²/sem'}</Pill>}{(bordesVistaMl ? faltFdvMl : faltFdvM2)>0 && <Pill>FDVH: {fmt(bordesVistaMl?faltFdvMl:faltFdvM2)} {bordesVistaMl?'ml/sem':'m²/sem'}</Pill>}</>) }</CardTitle>
        </CardHeader>
        <CardContent>
          {needBordes && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 text-sm p-2">
              <div><b>Total:</b> faltan {fmt(faltanteBordesM2)} m²/sem</div>
              {faltanteBordesMl>0 && <div><b>(equivalente):</b> faltan {fmt(faltanteBordesMl)} ml/sem</div>}
            </div>
          )}
          <div className="flex items-center gap-3 mb-2">
            <Switch checked={bordesVistaMl} onCheckedChange={setBordesVistaMl} />
            <span className="text-sm">Ver en {bordesVistaMl? 'ml' : 'm²'}</span>
          </div>
          {/* Controles de Bordes */}
          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <LineCtrl title="Bilateral" unit={bordesVistaMl?"ml":"m²"} state={bordes.Bil} onChange={(v)=>setBordes(s=>({...s,Bil:v}))} />
            <LineCtrl title="Forel CNC" unit={bordesVistaMl?"ml":"m²"} state={bordes.CNC} onChange={(v)=>setBordes(s=>({...s,CNC:v}))} />
            <LineCtrl title="Forel DVH" unit={bordesVistaMl?"ml":"m²"} state={bordes.DVH} onChange={(v)=>setBordes(s=>({...s,DVH:v}))} />
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="h-64"><StackChart data={bordesVistaMl ? dataBilMl : dataBilM2} xKey="linea" /></div>
            <div className="h-64"><StackChart data={bordesVistaMl ? dataCncMl : dataCncM2} xKey="linea" /></div>
            <div className="h-64"><StackChart data={bordesVistaMl ? dataDvhMl : dataDvhM2} xKey="linea" /></div>
          </div>
          <div className="mt-3 text-sm">Total m²/sem: <Brecha value={brechaBordesM2} unidad="m²/sem"/> · Total ml/sem: <Brecha value={brechaBordesMl} unidad="ml/sem"/></div>
          <div className="grid md:grid-cols-3 gap-2 mt-3 text-xs text-gray-600">
            <div>ml/m² Bilateral: <Input type="number" value={mlPerM2.Bilateral} onChange={(e)=>setMlPerM2(s=>({...s,Bilateral:Math.max(0.01,Number(e.target.value||0))}))}/></div>
            <div>ml/m² CNC: <Input type="number" value={mlPerM2.CNC} onChange={(e)=>setMlPerM2(s=>({...s,CNC:Math.max(0.01,Number(e.target.value||0))}))}/></div>
            <div>ml/m² Forel DVH: <Input type="number" value={mlPerM2.DVH} onChange={(e)=>setMlPerM2(s=>({...s,DVH:Math.max(0.01,Number(e.target.value||0))}))}/></div>
          </div>
        </CardContent>
      </Card>

      {/* GLASTON */}
      <Card className={`mb-6 ${needGlaston ? 'ring-2 ring-red-400' : ''}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Templado – Glaston (kg/sem) {needGlaston && (<><Pill>⚠ Necesita ajuste</Pill><Pill>Faltan: {fmt(faltanteGlaston)} kg/sem</Pill></>) }</CardTitle>
        </CardHeader>
        <CardContent>
          {needGlaston && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 text-sm p-2">
              <div><b>Faltan:</b> {fmt(faltanteGlaston)} kg/sem</div>
            </div>
          )}
          <LineCtrl title="Glaston" unit="kg" state={glaston} onChange={setGlaston} />
          <div className="h-64 mt-4"><StackChart data={dataGlaston} xKey="linea" /></div>
          <div className="mt-3 text-sm">Demanda: <b>{fmt(glastonKgSem)}</b> kg/sem · Capacidad: <b>{fmt(glastonCapSemKg)}</b> · Brecha: <Brecha value={brechaGlaston} unidad="kg/sem"/></div>
          <div className="mt-2 text-xs text-gray-600">
            <div><b>Detalle demanda (kg/día):</b> DVH templado {fmt(dvhTempladoDia*15)} + Templado simple {fmt(metasD.templado*20)} + Lam. especial (2 panes) {fmt((metasD.lamEspecial*2)*18)} = <b>{fmt(glastonKgDia)}</b></div>
          </div>
        </CardContent>
      </Card>

      {/* DVH ARMADO */}
      <Card className={`mb-6 ${needDvh ? 'ring-2 ring-red-400' : ''}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">DVH – Armado (m²/sem) {needDvh && (<><Pill>⚠ Necesita ajuste</Pill><Pill>Faltan: {fmt(faltanteDvh)} m²/sem</Pill></>) }</CardTitle>
        </CardHeader>
        <CardContent>
          {needDvh && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 text-sm p-2">
              <div><b>Faltan:</b> {fmt(faltanteDvh)} m²/sem</div>
            </div>
          )}
          <LineCtrl title="Armado DVH" unit="m²" state={dvh} onChange={setDvh} />
          <div className="h-64 mt-4"><StackChart data={dataDvh} xKey="linea" /></div>
          <div className="mt-3 text-sm">Demanda: <b>{fmt(dvhObjetivo * DEM_DAYS_WEEK)}</b> m²/sem · Capacidad: <b>{fmt(dvhCapSemM2)}</b> · Brecha: <Brecha value={brechaDvh} unidad="m²/sem"/></div>
        </CardContent>
      </Card>

      {/* BOVONE */}
      <Card className={`mb-12 ${needBovone ? 'ring-2 ring-red-400' : ''}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Laminado – Bovone (m²/mes) {needBovone && (<><Pill>⚠ Necesita ajuste</Pill><Pill>Faltan: {fmt(faltanteBovoneMes)} m²/mes</Pill></>) }</CardTitle>
        </CardHeader>
        <CardContent>
          {needBovone && (
            <div className="mb-3 rounded-md border border-red-300 bg-red-50 text-red-800 text-sm p-2">
              <div><b>Faltan:</b> {fmt(faltanteBovoneMes)} m²/mes</div>
            </div>
          )}
          <LineCtrl title="Bovone" unit="m²" state={bovone} onChange={setBovone} />
          <div className="h-64 mt-4"><StackChart data={dataBovone} xKey="mes" /></div>
          <div className="mt-3 text-sm">Producción (Bovone) + Distribución: <b>{fmt(bovoneDemMes)}</b> m²/mes · Capacidad: <b>{fmt(bovoneCapMesM2)}</b> · Brecha: <Brecha value={brechaBovoneMes} unidad="m²/mes"/></div>
          <div className="text-xs text-gray-500 mt-1">En Bovone no aplicamos merma; la merma (+30%) es de corte sobre laminado. Distribución sin merma.</div>
        </CardContent>
      </Card>

      {/* ACOPLAMIENTO Y COSTOS */}
      <div className="grid lg:grid-cols-2 gap-6 mb-12">
        <Card>
          <CardHeader><CardTitle>Acoplamiento de cadena – DVH máximo (m²/d)</CardTitle></CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-3 gap-2 text-sm">
              <div>Por <b>Jumbo</b>: {fmt(dvhMaxPorJumbo)}</div>
              <div>Por <b>Heglas</b>: {fmt(dvhMaxPorHeglas)}</div>
              <div>Por <b>Glaston</b>: {fmt(dvhMaxPorGlaston)}</div>
              <div>Por <b>Bordes</b>: {fmt(dvhMaxPorBordes)}</div>
              <div>Por <b>Bovone</b>: {fmt(dvhMaxPorBovone)}</div>
              <div>Por <b>Armado</b>: {fmt(dvhMaxPorArmado)}</div>
            </div>
            <div className="mt-3 text-base">DVH máximo por cadena: <b>{fmt(dvhMaxCadenaDia)}</b> m²/día</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Costos de estructura (mensual)</CardTitle></CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={dataCostos}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="area" />
                  <YAxis />
                  <Tooltip formatter={(v:any)=>money(v)} />
                  <Legend />
                  <Bar dataKey="Base" stackId="costo" fill="#94a3b8" />
                  <Bar dataKey="Extra" stackId="costo" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 text-sm">Total Base: <b>{money(costoTotalBase)}</b> · Total Extras: <b className="text-red-600">{money(costoTotalExtra)}</b> · <b>Total: {money(costoTotal)}</b></div>
            <div className="text-xs text-gray-600 mt-2">Dotación total estimada: <b>{fmt(dotTotal,2)}</b> operarios (6×2 aplica factor {FACTOR_DOT_6x2.toFixed(3)} para cubrir 7 días).</div>
            <div className="mt-3">
              <div className="text-sm font-medium">Incorporaciones requeridas vs dotación base</div>
              <div className="grid md:grid-cols-3 text-xs text-gray-700 mt-1 gap-y-1">
                <div>Jumbo: <b>{fmt(inc.Jumbo)}</b> op · {money(incCost.Jumbo)}</div>
                <div>Hegla 1: <b>{fmt(inc.Hegla1)}</b> op · {money(incCost.Hegla1)}</div>
                <div>Hegla 2: <b>{fmt(inc.Hegla2)}</b> op · {money(incCost.Hegla2)}</div>
                <div>Bilateral: <b>{fmt(inc.Bil)}</b> op · {money(incCost.Bil)}</div>
                <div>Forel CNC: <b>{fmt(inc.CNC)}</b> op · {money(incCost.CNC)}</div>
                <div>Forel DVH: <b>{fmt(inc.FDVH)}</b> op · {money(incCost.FDVH)}</div>
                <div>Glaston: <b>{fmt(inc.Glast)}</b> op · {money(incCost.Glast)}</div>
                <div>Armado DVH: <b>{fmt(inc.ArmDVH)}</b> op · {money(incCost.ArmDVH)}</div>
                <div>Bovone: <b>{fmt(inc.Bovone)}</b> op · {money(incCost.Bovone)}</div>
              </div>
              <div className="text-sm mt-2">Total incorporaciones: <b>{fmt(incTotalOps)}</b> op · Costo mensual: <b>{money(incTotalCost)}</b></div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* RESUMEN HH */}
      <Card className="mb-6">
        <CardHeader><CardTitle>HH/sem y dotación por área</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm grid grid-cols-2 gap-y-1">
            <div>Jumbo</div><div className="text-right">{fmt(hhSemana(corte.Jumbo.persTurno, corte.Jumbo.turnos, corte.Jumbo.sistema, corte.Jumbo.extra))} HH · {fmt(dotJumbo,2)} op</div>
            <div>Hegla 1</div><div className="text-right">{fmt(hhSemana(corte.H1.persTurno, corte.H1.turnos, corte.H1.sistema, corte.H1.extra))} HH · {fmt(dotH1,2)} op</div>
            <div>Hegla 2</div><div className="text-right">{fmt(hhSemana(corte.H2.persTurno, corte.H2.turnos, corte.H2.sistema, corte.H2.extra))} HH · {fmt(dotH2,2)} op</div>
            <div>Bilateral</div><div className="text-right">{fmt(hhSemana(bordes.Bil.persTurno, bordes.Bil.turnos, bordes.Bil.sistema, bordes.Bil.extra))} HH · {fmt(dotBil,2)} op</div>
            <div>Forel CNC</div><div className="text-right">{fmt(hhSemana(bordes.CNC.persTurno, bordes.CNC.turnos, bordes.CNC.sistema, bordes.CNC.extra))} HH · {fmt(dotCnc,2)} op</div>
            <div>Forel DVH</div><div className="text-right">{fmt(hhSemana(bordes.DVH.persTurno, bordes.DVH.turnos, bordes.DVH.sistema, bordes.DVH.extra))} HH · {fmt(dotDvhB,2)} op</div>
            <div>Glaston</div><div className="text-right">{fmt(hhSemana(glaston.persTurno, glaston.turnos, glaston.sistema, glaston.extra))} HH · {fmt(dotGlast,2)} op</div>
            <div>Armado DVH</div><div className="text-right">{fmt(hhSemana(dvh.persTurno, dvh.turnos, dvh.sistema, dvh.extra))} HH · {fmt(dotDvh,2)} op</div>
            <div>Bovone</div><div className="text-right">{fmt(hhSemana(bovone.persTurno, bovone.turnos, bovone.sistema, bovone.extra))} HH · {fmt(dotBov,2)} op</div>
          </div>
        </CardContent>
      </Card>

      {/* DOTACIÓN TOTAL POR LÍNEA – RESUMEN SIMPLE */}
      <Card>
        <CardHeader><CardTitle>Dotación total por línea (operarios)</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm grid grid-cols-2 gap-y-1">
            <div>Jumbo</div><div className="text-right">{fmt(dotJumbo,2)}</div>
            <div>Hegla 1</div><div className="text-right">{fmt(dotH1,2)}</div>
            <div>Hegla 2</div><div className="text-right">{fmt(dotH2,2)}</div>
            <div>Bilateral</div><div className="text-right">{fmt(dotBil,2)}</div>
            <div>Forel CNC</div><div className="text-right">{fmt(dotCnc,2)}</div>
            <div>Forel DVH</div><div className="text-right">{fmt(dotDvhB,2)}</div>
            <div>Glaston</div><div className="text-right">{fmt(dotGlast,2)}</div>
            <div>Armado DVH</div><div className="text-right">{fmt(dotDvh,2)}</div>
            <div>Bovone</div><div className="text-right">{fmt(dotBov,2)}</div>
            <div className="col-span-2 border-t mt-2 pt-2 font-medium">Total planta (sin supervisores): <span className="float-right">{fmt(dotTotal,2)}</span></div>
          </div>
        </CardContent>
      </Card>

      <div className="h-8" />
    </div>
  );
}

