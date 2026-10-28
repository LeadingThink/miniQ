import { Hand, SquareCheck, CircleAlert } from "lucide-react";
import type { ApprovalMode } from "../types";
import { MenuSelect, type MenuOption } from "./MenuSelect";

const MODE_OPTIONS: MenuOption<ApprovalMode>[] = [
  {
    value: "alwaysAsk",
    label: "请求批准",
    icon: Hand,
    desc: "编辑外部文件和使用互联网时始终询问",
  },
  {
    value: "auto",
    label: "帮我批准",
    icon: SquareCheck,
    desc: "仅对检测到的风险操作请求批准",
  },
  {
    value: "fullAccess",
    label: "完全访问",
    icon: CircleAlert,
    desc: "不受限制地访问互联网和你电脑上的任何文件",
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
      menuClassName="approval-mode-menu"
      onChange={props.onChange}
      menuLabel="执行权限"
      disabled={props.disabled}
      tone={props.mode === "fullAccess" ? "warn" : undefined}
    />
  );
}
