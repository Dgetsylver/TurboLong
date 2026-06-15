/**
 * Turbolong design-system component library (vanilla-TS).
 * Pure builders returning HTMLElement/SVGElement from typed props, styled via
 * --tl-* tokens. Import from this barrel — never from a component file directly.
 */

// DOM helper + formatters
export { el, on, mount, money, moneyDec, pct, lev } from "./el";
export type { Child, Attrs } from "./el";

// Core
export { Button } from "./button";
export type { ButtonProps } from "./button";
export { Badge } from "./badge";
export type { BadgeProps } from "./badge";
export { Card } from "./card";
export type { CardProps } from "./card";
export { AssetTab } from "./assetTab";
export type { AssetTabProps } from "./assetTab";

// Data
export { StatCard } from "./statCard";
export type { StatCardProps } from "./statCard";
export { MetricHero } from "./metricHero";
export type { MetricHeroProps } from "./metricHero";
export { Input } from "./input";
export type { InputProps } from "./input";
export { Sparkline, colorForTone } from "./sparkline";
export type { SparklineProps } from "./sparkline";

// Forms
export { Select } from "./select";
export type { SelectProps, SelectOption } from "./select";

// Risk
export { HealthFactor } from "./healthFactor";
export type { HealthFactorProps } from "./healthFactor";
export { RiskBand, zoneFromHF } from "./riskBand";
export type { RiskBandProps, RiskZone } from "./riskBand";
export { LeverageSlider, ZONES, activeZone } from "./leverageSlider";
export type { LeverageSliderProps, LeverageZone } from "./leverageSlider";

// Feedback
export { Tooltip } from "./tooltip";
export type { TooltipProps } from "./tooltip";
export { Modal } from "./modal";
export type { ModalProps } from "./modal";
export { Skeleton } from "./skeleton";
export type { SkeletonProps } from "./skeleton";
export { TxStepper } from "./txStepper";
export type { TxStepperProps } from "./txStepper";
