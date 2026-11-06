import { MenuSelect, type MenuOption } from "./MenuSelect";

function twoDigitOptions(count: number): MenuOption<string>[] {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
  });
}

const HOURS = twoDigitOptions(24);
const MINUTES = twoDigitOptions(60);

/** HH:mm picker whose listboxes stay inside the window, unlike the native time popup. */
export function TimeField(props: { label: string; value: string; onChange: (value: string) => void }) {
  const [hour = "00", minute = "00"] = props.value.split(":");
  return (
    <div className="time-field" role="group" aria-label={props.label}>
      <MenuSelect ariaLabel={`${props.label}小时`} menuLabel={`${props.label}小时`} menuClassName="time-field-menu time-field-menu-hours"
        value={hour} options={HOURS} onChange={(value) => props.onChange(`${value}:${minute}`)} />
      <span aria-hidden="true">:</span>
      <MenuSelect ariaLabel={`${props.label}分钟`} menuLabel={`${props.label}分钟`} menuClassName="time-field-menu time-field-menu-minutes"
        value={minute} options={MINUTES} onChange={(value) => props.onChange(`${hour}:${value}`)} />
    </div>
  );
}
