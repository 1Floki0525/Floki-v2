import React from 'react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function SettingRow({ label, description, type = 'toggle', value, onChange, options, min, max, step }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex-1 mr-4">
        <span className="text-sm text-foreground/90">{label}</span>
        {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">
        {type === 'toggle' && (
          <Switch checked={value} onCheckedChange={onChange} />
        )}
        {type === 'text' && (
          <Input
            value={value}
            onChange={e => onChange(e.target.value)}
            className="w-48 h-8 text-xs bg-secondary/30 border-border/30"
          />
        )}
        {type === 'number' && (
          <Input
            type="number"
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            min={min}
            max={max}
            step={step}
            className="w-24 h-8 text-xs bg-secondary/30 border-border/30"
          />
        )}
        {type === 'slider' && (
          <div className="w-36 flex items-center gap-2">
            <Slider
              value={[value]}
              onValueChange={([v]) => onChange(v)}
              min={min || 0}
              max={max || 100}
              step={step || 1}
              className="flex-1"
            />
            <span className="text-[10px] font-mono text-muted-foreground w-8 text-right">{value}</span>
          </div>
        )}
        {type === 'select' && (
          <Select value={String(value)} onValueChange={onChange}>
            <SelectTrigger className="w-36 h-8 text-xs bg-secondary/30 border-border/30">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {options.map(opt => (
                <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}