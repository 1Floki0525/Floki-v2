import { useState, useEffect, useCallback } from 'react';
import { getSettings, initializeSettings, updateSettings, subscribeSettings } from '@/stores/settingsStore';
export default function useSettings(section) {
  const [settings, setSettings] = useState(getSettings());
  useEffect(() => { const unsubscribe = subscribeSettings(setSettings); initializeSettings().catch((error) => console.error('YAML settings load failed', error)); return unsubscribe; }, []);
  const update = useCallback((values) => updateSettings(section, values), [section]);
  return [section ? settings[section] : settings, update];
}
