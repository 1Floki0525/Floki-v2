import React from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function SettingRow({
  label,
  description,
  type = 'toggle',
  value,
  onChange,
  options = [],
  min,
  max,
  step,
  disabled = false,
  readOnly = false,
  buttonLabel = 'Run',
}) {
  return (
    <div className="flex items-center justify-between py-1.5 gap-4">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-foreground/90">{label}</span>
        {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">
        {type === 'toggle' && (
          <Switch checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} />
        )}
        {type === 'text' && (
          <Input
            value={value ?? ''}
            onChange={(event) => onChange?.(event.target.value)}
            disabled={disabled}
            readOnly={readOnly}
            className="w-56 h-8 text-xs bg-secondary/30 border-border/30"
          />
        )}
        {type === 'number' && (
          <Input
            type="number"
            value={value}
            onChange={(event) => onChange?.(Number(event.target.value))}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            readOnly={readOnly}
            className="w-28 h-8 text-xs bg-secondary/30 border-border/30"
          />
        )}
        {type === 'slider' && (
          <div className="w-40 flex items-center gap-2">
            <Slider
              value={[Number(value || 0)]}
              onValueChange={([next]) => onChange?.(next)}
              min={min ?? 0}
              max={max ?? 100}
              step={step ?? 1}
              disabled={disabled}
              className="flex-1"
            />
            <span className="text-[10px] font-mono text-muted-foreground w-10 text-right">{value}</span>
          </div>
        )}
        {type === 'select' && (
          <Select value={String(value)} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger className="w-40 h-8 text-xs bg-secondary/30 border-border/30">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {options.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {type === 'button' && (
          <button
            type="button"
            onClick={onChange}
            disabled={disabled}
            className="px-3 py-1.5 rounded-md text-[10px] font-mono bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/20 hover:bg-neon-cyan/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  )
}
