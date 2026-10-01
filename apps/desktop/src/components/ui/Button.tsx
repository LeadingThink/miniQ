import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon rendered before the label. */
  icon?: ReactNode;
};

/** Icon-only buttons must carry an accessible name. */
export type ButtonProps =
  | (BaseProps & { iconOnly: true; "aria-label": string })
  | (BaseProps & { iconOnly?: false; "aria-label"?: string });

export function buttonClassName(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  iconOnly = false,
  extra?: string,
) {
  return [
    "ui-button",
    `ui-button--${variant}`,
    `ui-button--${size}`,
    iconOnly ? "ui-button--icon" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon, iconOnly = false, className, children, type, title, ...rest },
  ref,
) {
  const label = rest["aria-label"];
  if (import.meta.env.DEV && iconOnly && !label) {
    console.warn("[ui/Button] icon-only buttons require an aria-label");
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={buttonClassName(variant, size, iconOnly, className)}
      title={title ?? (iconOnly ? label : undefined)}
      {...rest}
    >
      {icon}
      {iconOnly ? null : children}
    </button>
  );
});
