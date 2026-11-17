const paths = {
  home: "M4 11.5 12 5l8 6.5M6.5 10v9h11v-9",
  history: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3h3M12 8v4.5l3 2",
  settings: "M5 7h8m4 0h2M5 17h2m4 0h8M15 5v4M9 15v4",
  copy: "M9 9h10v10H9zM5 15V5h10",
  insert: "M19 5v7a3 3 0 0 1-3 3H6m4-4-4 4 4 4",
  trash: "M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5 10 17l9-10",
  alert: "M12 4 3 19h18L12 4Zm0 6v4m0 3v.5",
  mic: "M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3ZM6 11.5a6 6 0 0 0 12 0M12 17.5V20",
  keyboard:
    "M3.5 7h17v10h-17zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8",
  download: "M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
  moon: "M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z",
  system: "M4 5h16v11H4zM9 20h6m-3-4v4",
  external: "M14 5h5v5m0-5-8 8M17 14v5H5V7h5",
  chevron: "m9 6 6 6-6 6",
  cleanup:
    "M10 4.5 11.4 8.6 15.5 10 11.4 11.4 10 15.5 8.6 11.4 4.5 10 8.6 8.6ZM17 14l.8 2.2L20 17l-2.2.8L17 20l-.8-2.2L14 17l2.2-.8Z",
  plus: "M12 5v14M5 12h14",
  edit: "M5 19h4L19 9l-4-4L5 15v4ZM13 7l4 4",
  radio:
    "M4.5 10.5h15v8.5h-15zM7 10.5 16.5 5M8.5 14.75h.01M15.5 13v3.5M13 14.75h5",
  play: "M8 5.5v13l10.5-6.5Z",
  pause: "M8.5 5.5v13M15.5 5.5v13",
  skip: "M6.5 6v12l8.5-6ZM17.5 6v12",
  book: "M5.5 4.5h10a3 3 0 0 1 3 3v12h-10a3 3 0 0 1-3-3zM5.5 16.5a3 3 0 0 1 3-3h10",
  voice: "M4.5 10v4M8.25 6.5v11M12 3.5v17M15.75 7v10M19.5 10v4",
  box: "M12 3.5 19.5 7.75v8.5L12 20.5l-7.5-4.25v-8.5ZM4.5 7.75 12 12l7.5-4.25M12 12v8.5",
  volume:
    "M4.5 9.5h3.5L12.5 6v12L8 14.5H4.5zM16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10",
  disk: "M5 6.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5v11c0 1.4-3.1 2.5-7 2.5s-7-1.1-7-2.5zM5 6.5C5 7.9 8.1 9 12 9s7-1.1 7-2.5M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5",
  chip: "M7 7h10v10H7zM10 10h4v4h-4zM10 4v3m4-3v3m-4 10v3m4-3v3M4 10h3m-3 4h3m10-4h3m-3 4h3",
  folder: "M4 7.5V18h16V9.5h-8L10 7H4Z",
  like: "M7.5 10.5v9h-3v-9zM7.5 10.5 11 4.2a2 2 0 0 1 3.4 1.9l-1 3.4h4.8a2 2 0 0 1 2 2.4l-1.1 5.9a2 2 0 0 1-2 1.7H7.5",
  dislike:
    "M7.5 13.5v-9h-3v9zM7.5 13.5l3.5 6.3a2 2 0 0 0 3.4-1.9l-1-3.4h4.8a2 2 0 0 0 2-2.4l-1.1-5.9a2 2 0 0 0-2-1.7H7.5",
  lock: "M6.5 11h11v8.5h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  heart:
    "M12 19.5s-7.5-4.5-7.5-9.6A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.3c0 5.1-7.5 9.6-7.5 9.6Z",
  send: "M4.5 11.2 19.5 4.5 12.8 19.5l-1.9-6.4ZM10.9 13.1l8.6-8.6",
  power: "M12 4v7.5M7.3 7.2a7 7 0 1 0 9.4 0",
  dice: "M5 5h14v14H5z",
  star: "m12 4.5 2.3 4.7 5.2.8-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.8Z",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.8v.4",
  checks: "m3.5 12.5 4 4L15 9m-3.5 7.5 1 1L20 10",
  more: "",
} as const;

/** Filled dots for icons a stroke cannot draw small enough. */
const dots: Partial<Record<keyof typeof paths, [number, number][]>> = {
  dice: [
    [9, 9],
    [15, 9],
    [12, 12],
    [9, 15],
    [15, 15],
  ],
  more: [
    [6, 12],
    [12, 12],
    [18, 12],
  ],
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name] && <path d={paths[name]} />}
      {dots[name]?.map(([cx, cy]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={name === "more" ? 1.6 : 1.3}
          fill="currentColor"
          stroke="none"
        />
      ))}
      {name === "settings" && (
        <>
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </>
      )}
    </svg>
  );
}
