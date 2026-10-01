import { Hand, SquareCheck, CircleAlert } from "lucide-react";
import type { ApprovalMode } from "../types";
import { MenuSelect, type MenuOption } from "./MenuSelect";

const MODE_OPTIONS: MenuOption<ApprovalMode>[] = [
  {
    value: "alwaysAsk",
    label: "请求批准",
    icon: Hand,
    desc: "修改文件和使用网络等操作每次都询问",
  },
  {
    value: "auto",
    label: "替我审批",
    icon: SquareCheck,
    desc: "常规操作自动执行，联网访问和危险命令等高风险操作才询问",
  },
  {
    value: "fullAccess",
    label: "完全访问",
    icon: CircleAlert,
    desc: "非阻止操作直接执行；确需选择时询问，3 分钟无回复自动继续",
  },
];

export function ApprovalModeSelect(props: {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
}) {
  const known = MODE_OPTIONS.some((option) => option.value === props.mode);
  return (
    <MenuSelect
      value={known ? props.mode : "auto"}
      options={MODE_OPTIONS}
      onChange={props.onChange}
      menuLabel="执行权限"
      disabled={props.disabled}
      tone={props.mode === "fullAccess" ? "warn" : undefined}
    />
  );
}
