'use client';

interface PM2MetricBarProps {
  value: number;
  max?: number;
  type?: 'cpu' | 'memory';
  showValue?: boolean;
}

export function PM2MetricBar({ value, max = 100, type = 'cpu', showValue = false }: PM2MetricBarProps) {
  const percentage = Math.min((value / max) * 100, 100);

  const getColorClass = () => {
    if (percentage < 25) return 'bg-accent';
    if (percentage < 50) return 'bg-accent';
    if (percentage < 75) return 'bg-warning';
    return 'bg-error';
  };

  return (
    <div className="flex items-center gap-2">
      <div className="metric-bar">
        <div
          className={`metric-bar-fill ${getColorClass()}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showValue && (
        <span className="text-xs text-muted tabular-nums">
          {type === 'cpu' ? `${value.toFixed(0)}%` : `${value.toFixed(0)}`}
        </span>
      )}
    </div>
  );
}
