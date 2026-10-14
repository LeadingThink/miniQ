import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { RemoteDeviceBar } from "../remoteDeviceBar";
import { RemoteDevicePicker } from "./RemoteDevicePicker";
import { Popover } from "./ui/Popover";
import "./RemoteComputerPicker.css";

export function RemoteComputerPicker({
  bar,
  children,
  onDetails,
}: {
  bar: RemoteDeviceBar;
  children: ReactNode;
  onDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="statusbar-identity"
        aria-label={`切换连接的电脑，当前：${bar.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
        <ChevronDown size={15} />
      </button>
      <Popover
        open={open}
        anchorRef={trigger}
        onClose={close}
        label="切换连接的电脑"
        className="remote-computer-popover"
      >
        <RemoteDevicePicker
          devices={bar.devices}
          selected={bar.selected}
          loading={bar.loading}
          error={bar.error}
          onRefresh={bar.onRefresh}
          onSelect={(device) => {
            close();
            bar.onSelect(device);
          }}
        />
        <button
          type="button"
          className="remote-computer-details"
          onClick={() => {
            close();
            onDetails();
          }}
        >
          查看会话与连接详情
        </button>
      </Popover>
    </>
  );
}
