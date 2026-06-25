import React, { useCallback, useEffect, useRef, useState } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';
import useSettings from '@/hooks/useSettings';
import { cn } from '@/lib/utils';
import { Activity, Camera, Eye, EyeOff, Snowflake } from 'lucide-react';

const TOGGLE_STYLES = {
  active: 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40',
  inactive: 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60',
};

function ToggleBtn({ label, active, onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-state={active ? 'on' : 'off'}
      onClick={onClick}
      data-testid={`toggle-${label.toLowerCase()}`}
      className={cn(
        'text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors tracking-wider uppercase',
        active ? TOGGLE_STYLES.active : TOGGLE_STYLES.inactive
      )}
    >
      {label}
    </button>
  );
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number * 100));
}

function DetectionLayer({ detections, stroke, fallbackLabel, showLabels, showConf }) {
  if (!Array.isArray(detections) || detections.length === 0) return null;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      data-testid={`detection-layer-${fallbackLabel}`}
      data-detection-count={detections.length}
    >
      {detections.map((detection, index) => {
        const box = detection.bbox || {};
        const left = clampPercent(box.x);
        const top = clampPercent(box.y);
        const width = Math.max(0, Math.min(100 - left, clampPercent(box.width)));
        const height = Math.max(0, Math.min(100 - top, clampPercent(box.height)));
        const confidence = Number(detection.confidence);
        const confidenceText = showConf && Number.isFinite(confidence)
          ? ` ${(confidence * 100).toFixed(0)}%`
          : '';
        return (
          <div
            key={detection.id || `${fallbackLabel}-${index}`}
            className="absolute border-2"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              borderColor: stroke,
            }}
          >
            {showLabels && (
              <span
                className="absolute left-0 top-0 max-w-full truncate bg-black/75 px-1 py-0.5 text-[10px] font-mono leading-none"
                style={{ color: stroke }}
              >
                {detection.label || detection.class || detection.name || fallbackLabel}
                {confidenceText}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function VisionPanel() {
  const [mjpegUrl, setMjpegUrl] = useState(null);
  const [frameMeta, setFrameMeta] = useState({ frameRate: 0, connectionStatus: 'offline', timestamp: 0 });
  const [frozen, setFrozen] = useState(false);
  const [frozenFrame, setFrozenFrame] = useState(null);
  const [blackout, setBlackout] = useState(false);
  const [visionSettings, updateVisionSettings] = useSettings('vision');
  const showObjects = visionSettings.showObjectBoxes !== false;
  const showPersons = visionSettings.showPersonBoxes !== false;
  const showLabels = visionSettings.showLabels !== false;
  const showConf = visionSettings.showConfidence !== false;
  const showScene = visionSettings.showSceneRecognition !== false;
  const [objects, setObjects] = useState([]);
  const [persons, setPersons] = useState([]);
  const [sceneLabel, setSceneLabel] = useState('');
  const [sceneConf, setSceneConf] = useState(null);
  const [detectionState, setDetectionState] = useState('warming');
  const [streamKey, setStreamKey] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const [streamLoaded, setStreamLoaded] = useState(false);
  const reconnectTimer = useRef(null);

  const refreshMeta = useCallback(async () => {
    try {
      const vision = await flokiAdapter.getVisionFrame();
      const connectionStatus = vision.connectionStatus || 'offline';
      const live = connectionStatus === 'active' && vision.frame?.fresh === true;
      setFrameMeta({
        frameRate: live ? Number(vision.frameRate || 0) : 0,
        connectionStatus: live ? 'active' : connectionStatus,
        timestamp: vision.timestamp || Date.now(),
      });
      setObjects(live && Array.isArray(vision.objects) ? vision.objects : []);
      setPersons(live && Array.isArray(vision.persons) ? vision.persons : []);
      const detectionFresh = live && vision.detection?.fresh === true && vision.detection?.stale !== true;
      setDetectionState(!live ? 'offline' : detectionFresh ? 'live' : vision.detection?.available ? 'stale' : 'warming');
      setSceneLabel(live && vision.scene?.available === true ? String(vision.scene.label || '') : '');
      const rawSceneConfidence = live ? vision.scene?.confidence : null;
      setSceneConf(
        rawSceneConfidence !== null &&
        rawSceneConfidence !== undefined &&
        Number.isFinite(Number(rawSceneConfidence))
          ? Number(rawSceneConfidence)
          : null
      );
    } catch (error) {
      console.error(error);
      setFrameMeta({ frameRate: 0, connectionStatus: 'offline', timestamp: Date.now() });
      setObjects([]);
      setPersons([]);
      setSceneLabel('');
      setSceneConf(null);
      setDetectionState('offline');
      setStreamLoaded(false);
      setStreamError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let url = null;
      try {
        url = await flokiAdapter.getMjpegUrl();
      } catch (error) {
        console.error(error);
        setStreamError(true);
      }
      if (cancelled) return;
      if (url) {
        setMjpegUrl(url);
        setStreamKey((key) => key + 1);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleStreamError = useCallback(() => {
    setStreamLoaded(false);
    setStreamError(true);
    setObjects([]);
    setPersons([]);
    setSceneLabel('');
    setDetectionState('offline');
    clearTimeout(reconnectTimer.current);
    const retry = async () => {
      try {
        const vision = await flokiAdapter.getVisionFrame();
        if (vision.connectionStatus === 'active' && vision.frame?.fresh === true) {
          const url = await flokiAdapter.getMjpegUrl();
          if (url) {
            const separator = url.includes('?') ? '&' : '?';
            setMjpegUrl(url + separator + 'reconnect=' + Date.now());
            setStreamKey((key) => key + 1);
            return;
          }
        }
      } catch (error) {
        console.error(error);
      }
      reconnectTimer.current = setTimeout(retry, 2000);
    };
    reconnectTimer.current = setTimeout(retry, 2000);
  }, []);

  useEffect(() => () => clearTimeout(reconnectTimer.current), []);

  useEffect(() => {
    refreshMeta();
    const interval = setInterval(refreshMeta, 1000);
    return () => clearInterval(interval);
  }, [refreshMeta]);

  const handleFreeze = useCallback(async () => {
    if (frozen) {
      setFrozen(false);
      setFrozenFrame(null);
      return;
    }
    const frame = await flokiAdapter.getLatestFrame();
    if (frame) {
      setFrozenFrame(frame);
      setFrozen(true);
    }
  }, [frozen]);

  const displayUrl = frozen ? frozenFrame : mjpegUrl;
  const active = frameMeta.connectionStatus === 'active' && streamLoaded && streamError === false;

  return (
    <NeonPanel title="Live Vision" badge={active ? 'LIVE' : 'OFFLINE'}>
      <div className="relative aspect-video rounded border border-border/40 bg-black/60 overflow-hidden group">
        {displayUrl ? (
          <>
            <img
              key={frozen ? 'frozen-frame' : streamKey}
              src={displayUrl}
              alt="Live webcam feed"
              data-testid="vision-feed"
              className={cn('w-full h-full object-cover transition-opacity', active ? 'opacity-100' : 'opacity-0')}
              style={{ filter: blackout ? 'brightness(0)' : undefined }}
              onLoad={() => { setStreamLoaded(true); setStreamError(false); }}
              onError={handleStreamError}
            />
            {active && !blackout && showObjects && (
              <DetectionLayer
                detections={objects}
                stroke="#84cc16"
                fallbackLabel="object"
                showLabels={showLabels}
                showConf={showConf}
              />
            )}
            {active && !blackout && showPersons && (
              <DetectionLayer
                detections={persons}
                stroke="#22d3ee"
                fallbackLabel="person"
                showLabels={showLabels}
                showConf={showConf}
              />
            )}
            {active && !blackout && (
              <div className="absolute bottom-2 left-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-muted-foreground">
                {frameMeta.frameRate.toFixed(1)} FPS
              </div>
            )}
            {active && !blackout && showScene && sceneLabel && (
              <div className="absolute bottom-2 right-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-muted-foreground max-w-[60%] truncate">
                {showConf && sceneConf != null ? `${sceneLabel} (${(sceneConf * 100).toFixed(0)}%)` : sceneLabel}
              </div>
            )}
            {!active && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-black/85">
                <Camera className="w-8 h-8 mb-3 text-muted-foreground/40" />
                <p className="text-sm text-foreground/80">
                  {streamError ? 'Vision stream unavailable' : 'Vision service warming'}
                </p>
              </div>
            )}
            {active && frozen && !blackout && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-[10px] font-mono px-2 py-1 rounded bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40 backdrop-blur-sm">
                  <Snowflake className="w-3 h-3 inline mr-1" />FROZEN
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <Camera className={cn('w-8 h-8 mb-3', active ? 'text-emerald-400 animate-pulse' : 'text-muted-foreground/40')} />
            <p className="text-sm text-foreground/80">
              {streamError ? 'Vision stream reconnecting' : 'Vision service offline or warming'}
            </p>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-muted-foreground/60">
        <span className="flex items-center gap-1">
          <Activity className="w-2.5 h-2.5" />
          {active ? 'Streaming' : 'Offline'}
        </span>
        <span className={cn(detectionState === 'live' ? 'text-emerald-400' : detectionState === 'stale' ? 'text-neon-amber' : 'text-muted-foreground/50')}>
          Detector: {detectionState}
        </span>
        <span>{new Date(frameMeta.timestamp).toLocaleTimeString()}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <ToggleBtn label="Objects" active={showObjects} onClick={() => updateVisionSettings({ showObjectBoxes: !showObjects })} />
        <ToggleBtn label="Persons" active={showPersons} onClick={() => updateVisionSettings({ showPersonBoxes: !showPersons })} />
        <ToggleBtn label="Labels" active={showLabels} onClick={() => updateVisionSettings({ showLabels: !showLabels })} />
        <ToggleBtn label="Conf" active={showConf} onClick={() => updateVisionSettings({ showConfidence: !showConf })} />
        <ToggleBtn label="Scene" active={showScene} onClick={() => updateVisionSettings({ showSceneRecognition: !showScene })} />
      </div>

      <div className="mt-2 flex gap-2">
        <button
          onClick={handleFreeze}
          data-testid="freeze-btn"
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono border transition-colors',
            frozen
              ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40'
              : 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60'
          )}
        >
          <Snowflake className="w-2.5 h-2.5" /> Freeze
        </button>
        <button
          onClick={() => setBlackout((value) => !value)}
          data-testid="blackout-btn"
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono border transition-colors',
            blackout
              ? 'bg-neon-red/20 text-neon-red border-neon-red/40'
              : 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60'
          )}
        >
          {blackout ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
          Blackout
        </button>
      </div>
    </NeonPanel>
  );
}
