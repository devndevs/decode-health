import type { Confidence } from "@decode-health/core/estimator";

export function UnverifiedBadge({ text, help }: { text: string; help: string }) {
  return (
    <span className="badge badge-warn" title={help}>
      <span aria-hidden="true">⚠ </span>
      {text}
      <span className="visually-hidden">: {help}</span>
    </span>
  );
}

export function ConfidenceBadge({ level, label, text }: { level: Confidence; label: string; text: string }) {
  return (
    <span className={`badge badge-${level}`}>
      <span className="visually-hidden">{label}: </span>
      {text}
    </span>
  );
}
