import { useState, useEffect, useCallback } from 'react';
import { getSettings, updateSettings, subscribeSettings } from '@/stores/settingsStore';

export default function useSettings(section) {
  const [settings, setSettings] = useState(getSettings());

  useEffect(() => {
    return subscribeSettings(setSettings);
  }, []);

  const update = useCallback((values) => {
    updateSettings(section, values);
  }, [section]);

  return [section ? settings[section] : settings, update];
}