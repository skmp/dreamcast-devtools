import { PANEL_IDS } from "../../lib/debuggerSchema";
import { RegisterPanel } from "./RegisterPanel";

// The twelve register panels: one table (RegisterPanel), bound to twelve ids. Which node of
// the device tree a panel shows is the server's to say: the node that offers the panel's id
// as an action. A server of milestone M2 offers `sh4-registers` on `dc.sh4.cpu`,
// `arm7-registers` on `dc.aica.arm7` and each of the other ten on one on-chip module of the SH4.

// the two processors
export const Sh4RegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_REGISTERS} />;
export const Arm7RegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.ARM7_REGISTERS} />;

// the on-chip modules of the SH4
export const BscRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_BSC_REGISTERS} />;
export const CcnRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_CCN_REGISTERS} />;
export const CpgRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_CPG_REGISTERS} />;
export const DmacRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_DMAC_REGISTERS} />;
export const IntcRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_INTC_REGISTERS} />;
export const RtcRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_RTC_REGISTERS} />;
export const SciRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_SCI_REGISTERS} />;
export const ScifRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_SCIF_REGISTERS} />;
export const TmuRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_TMU_REGISTERS} />;
export const UbcRegistersPanel = () => <RegisterPanel panelId={PANEL_IDS.SH4_UBC_REGISTERS} />;
