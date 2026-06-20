import React, { useEffect, useRef, useState, useCallback } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';
import { cn } from '@/lib/utils';
import { Eye, EyeOff, Snowflake, Camera, Activity } from 'lucide-react';

const TOGGLE_STYLES = {
  active: 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40',
  inactive: 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60',
};

function ToggleBtn({ label, active, onClick }) {
  return (
    <button
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

export default function VisionPanel() {
  const [mjpegUrl, setMjpegUrl] = useState(null);
  const [frameMeta, setFrameMeta] = useState({ frameRate: 0, connectionStatus: 'offline', timestamp: 0 });
  const [frozen, setFrozen] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [showObjects, setShowObjects] = useState(true);
  const [showFaces, setShowFaces] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showConf, setShowConf] = useState(true);
  const [showScene, setShowScene] = useState(true);
  const [objects, setObjects] = useState([]);
  const [faces, setFaces] = useState([]);
  const [sceneLabel, setSceneLabel] = useState('No current visual description');
  const [sceneConf, setSceneConf] = useState(0);
  const [streamKey, setStreamKey] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const frozenUrl = useRef(null);
  const metaRef = useRef(null);
  const reconnectTimer = useRef(null);

  const refreshMeta = useCallback(async () => {
    try {
      const vision = await flokiAdapter.getVisionFrame();
      metaRef.current = {
        frameRate: Number(vision.frameRate || 0),
        connectionStatus: vision.connectionStatus || 'offline',
        timestamp: vision.timestamp || Date.now(),
      };
      setFrameMeta(metaRef.current);
      setObjects(Array.isArray(vision.objects) ? vision.objects : []);
      setFaces(Array.isArray(vision.faces) ? vision.faces : []);
      setSceneLabel(vision.scene?.label || 'No current visual description');
      setSceneConf(Number(vision.scene?.confidence || 0));
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = await flokiAdapter.getMjpegUrl();
      if (cancelled) return;
      if (url) {
        setMjpegUrl(url);
        frozenUrl.current = url;
        setStreamKey((k) => k + 1);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleStreamError = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(async () => {
      const url = await flokiAdapter.getMjpegUrl();
      if (url) {
        setMjpegUrl(url);
        setStreamKey((k) => k + 1);
      }
    }, 2000);
  }, []);

  useEffect(() => {
    return () => clearTimeout(reconnectTimer.current);
  }, []);

  useEffect(() => {
    refreshMeta();
    const interval = setInterval(refreshMeta, 2000);
    return () => clearInterval(interval);
  }, [refreshMeta]);

  const handleFreeze = () => {
    if (!frozen) {
      frozenUrl.current = mjpegUrl;
    }
    setFrozen((prev) => !prev);
  };

  const displayUrl = blackout ? null : (frozen ? frozenUrl.current : mjpegUrl);
  const active = frameMeta.connectionStatus === 'active';

  return (
    <NeonPanel title="Live Vision" badge={active ? 'LIVE' : 'OFFLINE'}>
      <div className="relative aspect-video rounded border border-border/40 bg-black/60 overflow-hidden group">
        {displayUrl ? (
          <>
            <img
              key={streamKey}
              src={displayUrl}
              alt="Live webcam feed"
              data-testid="vision-feed"
              className="w-full h-full object-cover"
              style={{ filter: blackout ? 'brightness(0)' : undefined }}
              onError={handleStreamError}
            />
            {showObjects && objects.length > 0 && (
              <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                {objects.map((obj, i) => (
                  <span key={i} className="text-[9px] font-mono px-1 py-0.5 rounded bg-emerald-900/60 text-emerald-300 border border-emerald-500/30">
                    {obj.label || obj.class || obj.name || 'object'}
                    {showConf && obj.confidence != null ? ` ${(obj.confidence * 100).toFixed(0)}%` : ''}
                  </span>
                ))}
              </div>
            )}
            {showFaces && faces.length > 0 && (
              <div className="absolute top-2 right-2 flex flex-wrap gap-1">
                {faces.map((face, i) => (
                  <span key={i} className="text-[9px] font-mono px-1 py-0.5 rounded bg-blue-900/60 text-blue-300 border border-blue-500/30">
                    Face {i + 1}{showConf && face.confidence != null ? ` ${(face.confidence * 100).toFixed(0)}%` : ''}
                  </span>
                ))}
              </div>
            )}
            {showLabels && (
              <div className="absolute bottom-2 left-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-muted-foreground">
                {frameMeta.frameRate.toFixed(1)} FPS
              </div>
            )}
            {showScene && sceneLabel && (
              <div className="absolute bottom-2 right-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-muted-foreground max-w-[60%] truncate">
                {showConf ? `${sceneLabel} (${(sceneConf * 100).toFixed(0)}%)` : sceneLabel}
              </div>
            )}
            {frozen && (
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
            <p className="text-sm text-foreground/80">{sceneLabel}</p>
            <p className="mt-2 text-[10px] text-muted-foreground font-mono">
              {active ? `${frameMeta.frameRate.toFixed(1)} FPS · live Floki webcam service` : 'vision service offline or warming'}
            </p>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-muted-foreground/60">
        <span className="flex items-center gap-1"><Activity className="w-2.5 h-2.5" />{active ? 'Streaming' : 'Offline'}</span>
        <span>{new Date(frameMeta.timestamp).toLocaleTimeString()}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <ToggleBtn label="Objects" active={showObjects} onClick={() => setShowObjects((p) => !p)} />
        <ToggleBtn label="Faces" active={showFaces} onClick={() => setShowFaces((p) => !p)} />
        <ToggleBtn label="Labels" active={showLabels} onClick={() => setShowLabels((p) => !p)} />
        <ToggleBtn label="Conf" active={showConf} onClick={() => setShowConf((p) => !p)} />
        <ToggleBtn label="Scene" active={showScene} onClick={() => setShowScene((p) => !p)} />
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
          onClick={() => setBlackout((p) => !p)}
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
