import React, { useCallback, useEffect, useRef, useState } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';
import useSettings from '@/hooks/useSettings';
import { cn } from '@/lib/utils';
import {
  clampRectToDisplay,
  emptyOverlayState,
  mapNormalizedBoxToVideoRect,
  reduceOverlayFrameState
} from '@/lib/visionOverlayGeometry';
import { Activity, Camera, Eye, EyeOff, Snowflake } from 'lucide-react';

const TOGGLE_STYLES = {
  active: 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40',
  inactive: 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60',
};

const WEB_FRAME_POLL_SUCCESS_DELAY_MS = 125;
const WEB_FRAME_POLL_FAILURE_BASE_DELAY_MS = 250;
const WEB_FRAME_POLL_MAX_BACKOFF_MS = 2000;
const WEB_FRAME_REQUEST_TIMEOUT_MS = 5000;
const WEB_FRAME_FAILURE_GRACE_MS = 5000;
const WEB_FRAME_FAILURE_THRESHOLD = 3;
const WEB_META_FAILURE_THRESHOLD = 3;
const WEB_RETIRED_FRAME_REVOKE_DELAY_MS = 1000;

function preloadBlobUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.decoding = 'async';
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('latest vision frame could not be decoded'));
    };
    image.src = url;
  });
}

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

function detectionKey(frameKey, fallbackLabel, detection, index) {
  return [
    frameKey || 'frame',
    fallbackLabel,
    detection.id || detection.label || detection.class || detection.name || 'detection',
    index
  ].join(':');
}

function DetectionLayer({ detections, stroke, fallbackLabel, showLabels, showConf, frame, display, frameKey }) {
  if (!Array.isArray(detections) || detections.length === 0) return null;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      data-testid={`detection-layer-${fallbackLabel}`}
      data-detection-count={detections.length}
    >
      {detections.map((detection, index) => {
        const rect = clampRectToDisplay(
          mapNormalizedBoxToVideoRect(detection.bbox || {}, {
            sourceWidth: frame.width,
            sourceHeight: frame.height,
            displayWidth: display.width,
            displayHeight: display.height,
            objectFit: 'cover',
            mirrored: false,
          }),
          display.width,
          display.height
        );
        if (!rect) return null;
        const confidence = Number(detection.confidence);
        const confidenceText = showConf && Number.isFinite(confidence)
          ? ` ${(confidence * 100).toFixed(0)}%`
          : '';
        return (
          <div
            key={detectionKey(frameKey, fallbackLabel, detection, index)}
            className="absolute border-2"
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
              borderColor: stroke,
              borderStyle: detection.certainty === 'uncertain' ? 'dashed' : 'solid',
              opacity: detection.certainty === 'uncertain' ? 0.55 : 1,
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
  const [overlayFrame, setOverlayFrame] = useState(() => emptyOverlayState());
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 });
  const [frozen, setFrozen] = useState(false);
  const [frozenFrame, setFrozenFrame] = useState(null);
  const [blackout, setBlackout] = useState(false);
  const [jpgUrl, setJpgUrl] = useState(null);
  const [jpgFrameUrl, setJpgFrameUrl] = useState(null);
  const [visionSettings, updateVisionSettings] = useSettings('vision');
  const showObjects = visionSettings.showObjectBoxes !== false;
  const showPersons = visionSettings.showPersonBoxes !== false;
  const showLabels = visionSettings.showLabels !== false;
  const showConf = visionSettings.showConfidence !== false;
  const showScene = visionSettings.showSceneRecognition !== false;
  const objects = overlayFrame.objects;
  const persons = overlayFrame.persons;
  const faces = overlayFrame.faces;
  const overlayFrameKey = [
    overlayFrame.streamSessionId || 'session',
    overlayFrame.resultSequence ?? overlayFrame.frameSequence ?? 'frame'
  ].join(':');
  const [sceneLabel, setSceneLabel] = useState('');
  const [sceneConf, setSceneConf] = useState(null);
  const [detectionState, setDetectionState] = useState('warming');
  const [streamKey, setStreamKey] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const [streamLoaded, setStreamLoaded] = useState(false);
  const reconnectTimer = useRef(null);
  const videoBoxRef = useRef(null);
  const jpgFrameUrlRef = useRef(null);
  const frameFailureCountRef = useRef(0);
  const metaFailureCountRef = useRef(0);
  const lastGoodFrameAtRef = useRef(0);
  const metaInFlightRef = useRef(false);

  const refreshMeta = useCallback(async () => {
    if (metaInFlightRef.current) return;
    metaInFlightRef.current = true;

    const markUnavailableAfterGrace = (connectionStatus = 'offline') => {
      metaFailureCountRef.current += 1;
      const recentFrame =
        lastGoodFrameAtRef.current > 0 &&
        Date.now() - lastGoodFrameAtRef.current < WEB_FRAME_FAILURE_GRACE_MS;
      if (
        metaFailureCountRef.current < WEB_META_FAILURE_THRESHOLD ||
        recentFrame
      ) {
        return;
      }
      setFrameMeta({
        frameRate: 0,
        connectionStatus,
        timestamp: Date.now(),
      });
      setOverlayFrame(emptyOverlayState());
      setSceneLabel('');
      setSceneConf(null);
      setDetectionState('offline');
    };

    try {
      const vision = await flokiAdapter.getVisionFrame();
      const connectionStatus = vision.connectionStatus || 'offline';
      const live = connectionStatus === 'active' && vision.frame?.fresh === true;

      if (!live) {
        markUnavailableAfterGrace(connectionStatus);
        return;
      }

      metaFailureCountRef.current = 0;
      setFrameMeta({
        frameRate: Number(vision.frameRate || 0),
        connectionStatus: 'active',
        timestamp: vision.timestamp || Date.now(),
      });
      setOverlayFrame((previous) => reduceOverlayFrameState(previous, vision, {
        maxAgeMs: Number(vision.detection?.maxAgeMs || vision.detection?.max_age_ms || 8000),
        blackout,
      }));
      const detectionFresh =
        vision.detection?.fresh === true &&
        vision.detection?.stale !== true;
      setDetectionState(
        detectionFresh
          ? 'live'
          : vision.detection?.available
            ? 'stale'
            : 'warming'
      );
      setSceneLabel(
        vision.scene?.available === true
          ? String(vision.scene.label || '')
          : ''
      );
      const rawSceneConfidence = vision.scene?.confidence;
      setSceneConf(
        rawSceneConfidence !== null &&
        rawSceneConfidence !== undefined &&
        Number.isFinite(Number(rawSceneConfidence))
          ? Number(rawSceneConfidence)
          : null
      );
    } catch (error) {
      console.error(error);
      markUnavailableAfterGrace('offline');
    } finally {
      metaInFlightRef.current = false;
    }
  }, [blackout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let url = null;
      let fallbackUrl = null;
      try {
        url = await flokiAdapter.getMjpegUrl();
        if (!url) fallbackUrl = await flokiAdapter.getVisionFrameUrl();
      } catch (error) {
        console.error(error);
        try { fallbackUrl = await flokiAdapter.getVisionFrameUrl(); } catch (_e) {}
        setStreamError(!fallbackUrl);
      }
      if (cancelled) return;
      if (url) {
        setMjpegUrl(url);
        setStreamKey((key) => key + 1);
      } else if (fallbackUrl) {
        setMjpegUrl(null);
        setJpgUrl(fallbackUrl);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleStreamError = useCallback(() => {
    if (!mjpegUrl && jpgUrl) {
      frameFailureCountRef.current += 1;
      const recentFrame =
        lastGoodFrameAtRef.current > 0 &&
        Date.now() - lastGoodFrameAtRef.current < WEB_FRAME_FAILURE_GRACE_MS;
      if (
        frameFailureCountRef.current >= WEB_FRAME_FAILURE_THRESHOLD &&
        !recentFrame
      ) {
        setStreamLoaded(false);
        setStreamError(true);
      }
      return;
    }
    setStreamLoaded(false);
    setStreamError(true);
    setOverlayFrame(emptyOverlayState());
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
  }, [jpgUrl, mjpegUrl]);

  useEffect(() => () => clearTimeout(reconnectTimer.current), []);

  useEffect(() => {
    if (blackout) setOverlayFrame(emptyOverlayState());
  }, [blackout]);

  useEffect(() => {
    const element = videoBoxRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setOverlaySize({
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    refreshMeta();
    const interval = setInterval(refreshMeta, 1000);
    return () => clearInterval(interval);
  }, [refreshMeta]);

  useEffect(() => {
    if (mjpegUrl || !jpgUrl) return undefined;
    let cancelled = false;
    let inFlight = false;
    let timer = null;
    let requestTimeout = null;
    let controller = null;
    let requestTimedOut = false;
    const retiredUrls = new Map();

    const revokeNow = (url) => {
      if (url) URL.revokeObjectURL(url);
    };

    const retireFrameUrl = (url) => {
      if (!url) return;
      const retireTimer = window.setTimeout(() => {
        retiredUrls.delete(retireTimer);
        revokeNow(url);
      }, WEB_RETIRED_FRAME_REVOKE_DELAY_MS);
      retiredUrls.set(retireTimer, url);
    };

    const markFrameFailure = (error) => {
      frameFailureCountRef.current += 1;
      const recentFrame =
        lastGoodFrameAtRef.current > 0 &&
        Date.now() - lastGoodFrameAtRef.current < WEB_FRAME_FAILURE_GRACE_MS;
      if (
        frameFailureCountRef.current >= WEB_FRAME_FAILURE_THRESHOLD &&
        !recentFrame
      ) {
        setStreamLoaded(false);
        setStreamError(true);
      }
      if (error) console.error(error);
    };

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      requestTimedOut = false;
      controller = new AbortController();
      requestTimeout = window.setTimeout(() => {
        requestTimedOut = true;
        controller?.abort();
      }, WEB_FRAME_REQUEST_TIMEOUT_MS);

      try {
        const frame = await flokiAdapter.getVisionFrameBlob({
          signal: controller.signal
        });
        const nextUrl = URL.createObjectURL(frame.blob);

        try {
          await preloadBlobUrl(nextUrl);
        } catch (error) {
          revokeNow(nextUrl);
          throw error;
        }

        if (cancelled) {
          revokeNow(nextUrl);
          return;
        }

        const previousUrl = jpgFrameUrlRef.current;
        jpgFrameUrlRef.current = nextUrl;
        setJpgFrameUrl(nextUrl);
        if (previousUrl && previousUrl !== nextUrl) {
          retireFrameUrl(previousUrl);
        }

        frameFailureCountRef.current = 0;
        metaFailureCountRef.current = 0;
        lastGoodFrameAtRef.current = Date.now();
        setStreamLoaded(true);
        setStreamError(false);
        if (frame.timestamp) {
          setFrameMeta((previous) => ({
            ...previous,
            connectionStatus: 'active',
            timestamp: Date.parse(frame.timestamp) || Date.now()
          }));
        }
      } catch (error) {
        if (
          !cancelled &&
          (error?.name !== 'AbortError' || requestTimedOut)
        ) {
          markFrameFailure(error);
        }
      } finally {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
          requestTimeout = null;
        }
        inFlight = false;
        controller = null;

        if (!cancelled) {
          const failures = frameFailureCountRef.current;
          const retryDelay = failures === 0
            ? WEB_FRAME_POLL_SUCCESS_DELAY_MS
            : Math.min(
                WEB_FRAME_POLL_MAX_BACKOFF_MS,
                WEB_FRAME_POLL_FAILURE_BASE_DELAY_MS *
                  (2 ** Math.min(failures - 1, 3))
              );
          const delay =
            typeof document !== 'undefined' && document.hidden
              ? Math.max(1000, retryDelay)
              : retryDelay;
          timer = window.setTimeout(poll, delay);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (requestTimeout) clearTimeout(requestTimeout);
      if (controller) controller.abort();
      for (const [retireTimer, url] of retiredUrls.entries()) {
        clearTimeout(retireTimer);
        revokeNow(url);
      }
      retiredUrls.clear();
      revokeNow(jpgFrameUrlRef.current);
      jpgFrameUrlRef.current = null;
      setJpgFrameUrl(null);
    };
  }, [mjpegUrl, jpgUrl]);

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

  const displayUrl = frozen ? frozenFrame : (mjpegUrl || jpgFrameUrl);
  const active = frameMeta.connectionStatus === 'active' && streamLoaded && streamError === false;

  return (
    <NeonPanel title="Live Vision" badge={active ? 'LIVE' : 'OFFLINE'}>
      <div ref={videoBoxRef} className="relative aspect-video rounded border border-border/40 bg-black/60 overflow-hidden group">
        {displayUrl ? (
          <>
            <img
              key={frozen ? 'frozen-frame' : (mjpegUrl ? `mjpeg-${streamKey}` : 'jpeg-stream')}
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
                frame={overlayFrame.frame}
                display={overlaySize}
                frameKey={overlayFrameKey}
              />
            )}
            {active && !blackout && showPersons && (
              <DetectionLayer
                detections={persons}
                stroke="#22d3ee"
                fallbackLabel="person"
                showLabels={showLabels}
                showConf={showConf}
                frame={overlayFrame.frame}
                display={overlaySize}
                frameKey={overlayFrameKey}
              />
            )}
            {active && !blackout && showPersons && (
              <DetectionLayer
                detections={faces}
                stroke="#f472b6"
                fallbackLabel="face"
                showLabels={showLabels}
                showConf={showConf}
                frame={overlayFrame.frame}
                display={overlaySize}
                frameKey={overlayFrameKey}
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
