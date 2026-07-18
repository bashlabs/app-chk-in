export function Cross({ size = 44 }: { size?: number }) {
  return (
    <svg
      className="cross"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="10" y="2" width="4" height="20" rx="1" />
      <rect x="5" y="7.5" width="14" height="4" rx="1" />
    </svg>
  );
}
