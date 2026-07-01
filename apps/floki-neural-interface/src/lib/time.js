const TORONTO_TIME_ZONE = 'America/Toronto'

export function formatTorontoTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return options.fallback || '--:--:--'

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: options.includeSeconds === false ? undefined : '2-digit',
    hour12: true,
  }).format(date)
}

export { TORONTO_TIME_ZONE }
