import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { applyBackground, getActiveBackground, subscribeBackground } from "../background";
import type { BackgroundDefinition } from "../backgroundCatalog";
import { loadBackgroundVideo } from "../backgroundVideo";
import { getMobileBackground, initializeMobileBackgroundPolicy, mobileBackgroundPolicy } from "../mobileBackgroundPolicy";
import { isNativeMobileApp } from "../mobileRuntime";

function subscribeReducedMotion(listener: () => void) {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  query?.addEventListener?.("change", listener);
  return () => query?.removeEventListener?.("change", listener);
}
const prefersReducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

interface NetworkInformationLike extends EventTarget {
  saveData?: boolean;
  effectiveType?: string;
}
const connection = () => (navigator as Navigator & { connection?: NetworkInformationLike }).connection;

/** Data saver or a very slow link: show covers and still frames instead of video. */
export function prefersLiteMedia(): boolean {
  const info = connection();
  if (!info) return false;
  return info.saveData === true || info.effectiveType === "slow-2g" || info.effectiveType === "2g";
}
function subscribeLiteMedia(listener: () => void) {
  const info = connection();
  info?.addEventListener?.("change", listener);
  return () => info?.removeEventListener?.("change", listener);
}

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const isDocumentHidden = () => document.hidden;

function subscribeMobilePolicy(listener: () => void) {
  if (!isNativeMobileApp()) return subscribeBackground(listener);
  return mobileBackgroundPolicy.subscribe(listener);
}
const getRenderedBackground = () => isNativeMobileApp() ? getMobileBackground() : getActiveBackground();

/** Enter takes 1.2s; the old layer fades out between 0.6s and 1.5s. */
const LAYER_SETTLE_MS = 1600;

interface Layer {
  background: BackgroundDefinition;
  leaving: boolean;
}

/**
 * Fixed layer behind the app shell. A new background fades in over the old one.
 * Video wallpapers show their cover first, then fade in a seamless A/B loop;
 * glyph and ambient scenes animate on a canvas. Respects prefers-reduced-motion
 * and data saver (still cover / single frame) and pauses while hidden.
 */
export function LivingBackground() {
  const background = useSyncExternalStore(subscribeMobilePolicy, getRenderedBackground, getRenderedBackground);
  const policyState = useSyncExternalStore(subscribeMobilePolicy, () => JSON.stringify(mobileBackgroundPolicy.getSnapshot()));
  const mobile = isNativeMobileApp();
  useEffect(() => { if (mobile) applyBackground(background); }, [background, mobile]);
  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  const liteMedia = useSyncExternalStore(subscribeLiteMedia, prefersLiteMedia);
  const hidden = useSyncExternalStore(subscribeVisibility, isDocumentHidden);
  useEffect(() => initializeMobileBackgroundPolicy(), []);
  const mobileSnapshot: ReturnType<typeof mobileBackgroundPolicy.getSnapshot> = JSON.parse(policyState);
  const lowPower = mobile && (mobileSnapshot.preferences.motion === "low-power" || mobileSnapshot.conditions.lowPower === true);
  const still = reduceMotion || liteMedia || (mobileSnapshot.isNative && !mobileSnapshot.canAnimate);
  const [layers, setLayers] = useState<Layer[]>(() => [{ background, leaving: false }]);

  const current = layers[layers.length - 1]?.background;
  if (current !== background) {
    // Derive the layer stack during render so the new layer appears in the same frame.
    const kept = still || mobile ? [] : layers.filter((layer) => !layer.leaving).map((layer) => ({ ...layer, leaving: true }));
    setLayers([...kept.slice(-1), { background, leaving: false }]);
  }

  const hasLeaving = layers.some((layer) => layer.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const timer = window.setTimeout(() => setLayers((list) => list.filter((layer) => !layer.leaving)), LAYER_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [hasLeaving, background]);

  const visible = layers.filter((layer) => layer.background.kind !== "none");
  if (!visible.length) return null;
  return (
    <div
      className={`living-background${hidden || (mobile && !mobileSnapshot.canAnimate) ? " is-paused" : ""}${mobile ? " is-mobile" : ""}${lowPower ? " is-low-power" : ""}${background.light ? " is-light" : ""}${still ? " is-still" : ""}`}
      data-kind={background.kind}
      aria-hidden="true"
    >
      {visible.map(({ background: item, leaving }) => (
        <div
          key={item.id}
          className={`living-background-layer${leaving ? " is-leaving" : " is-entering"}`}
          data-kind={item.kind}
        >
          {item.kind === "video" ? (
            <VideoWallpaper background={item} still={still} paused={hidden || leaving || (mobileSnapshot.isNative && !mobileSnapshot.canPlayVideo)} />
          ) : (
            <SceneCanvas background={item} lowPower={lowPower} still={still} paused={hidden || leaving || (mobile && !mobileSnapshot.canAnimate)} />
          )}
        </div>
      ))}
      <div className="living-background-scrim" />
    </div>
  );
}

function VideoWallpaper({
  background,
  still,
  paused,
}: {
  background: BackgroundDefinition;
  still: boolean;
  paused: boolean;
}) {
  const [source, setSource] = useState<string>();
  const allowed = !isNativeMobileApp() || mobileBackgroundPolicy.getSnapshot().canPlayVideo;

  useEffect(() => {
    if (still || !background.video || !allowed) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    const load = isNativeMobileApp()
      ? mobileBackgroundPolicy.downloadVideo(background.video)
      : loadBackgroundVideo(background.video);
    load.then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      },
      // Offline or CDN failure: the cover stays as the wallpaper.
      () => undefined,
    );
    return () => {
      cancelled = true;
      setSource(undefined);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [background.video, still, allowed]);

  const drift = background.drift !== false && !still && !isNativeMobileApp();
  return (
    <>
      {background.poster && (
        <img
          className={`living-background-media living-background-poster${drift ? " is-drifting" : ""}`}
          src={background.poster}
          alt=""
          draggable={false}
        />
      )}
      {source && (
        isNativeMobileApp() ? <MobileVideo key={source} src={source} paused={paused} onError={() => setSource(undefined)} /> : <VideoLoop key={source} src={source} drift={drift} paused={paused} onError={() => setSource(undefined)} />
      )}
    </>
  );
}

function MobileVideo({ src, paused, onError }: { src: string; paused: boolean; onError: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (paused) video.pause();
    else void video.play().catch(onError);
    return () => video.pause();
  }, [src, paused]);
  return <video ref={ref} src={src} muted loop playsInline preload="metadata" className="living-background-media" onError={onError} />;
}

/** Crossfade length in seconds and how early it starts before the clip ends. */
const FADE = 1.6;
const LEAD = 0.3;
type SlotState = "front" | "behind" | "idle";

/**
 * Seamless loop: two muted players take turns. Shortly before the front clip
 * ends, the other one restarts from zero and fades in over it, so the loop
 * point never shows a hard cut. Falls back to `ended` for short clips.
 */
function VideoLoop({
  src,
  drift,
  paused,
  onError,
}: {
  src: string;
  drift: boolean;
  paused: boolean;
  onError: () => void;
}) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const slots = [first, second];
  const active = useRef(0);
  const fading = useRef(false);
  const settleTimer = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const pausedRef = useRef(paused);
  const [states, setStates] = useState<[SlotState, SlotState]>(["front", "idle"]);
  const [playing, setPlaying] = useState(false);
  const [warm, setWarm] = useState(false);

  const crossfade = useCallback(() => {
    if (fading.current || pausedRef.current) return;
    const from = active.current;
    const to = 1 - from;
    const current = (from === 0 ? first : second).current;
    const next = (to === 0 ? first : second).current;
    if (!current || !next) return;
    fading.current = true;
    const token = ++generation.current;
    next.currentTime = 0;
    Promise.resolve(next.play()).then(
      () => {
        if (token !== generation.current || pausedRef.current) {
          next.pause();
          fading.current = false;
          return;
        }
        active.current = to;
        setStates(to === 0 ? ["front", "behind"] : ["behind", "front"]);
        settleTimer.current = window.setTimeout(
          () => {
            if (token !== generation.current) return;
            current.pause();
            setStates(to === 0 ? ["front", "idle"] : ["idle", "front"]);
            fading.current = false;
          },
          FADE * 1000 + 120,
        );
      },
      () => {
        if (token !== generation.current || pausedRef.current) {
          fading.current = false;
          return;
        }
        // The second player cannot start: restart the current clip instead.
        fading.current = false;
        current.currentTime = 0;
        void Promise.resolve(current.play()).catch(() => undefined);
      },
    );
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      generation.current += 1;
      fading.current = false;
      window.clearTimeout(settleTimer.current);
      first.current?.pause();
      second.current?.pause();
    }
  }, [paused]);

  useEffect(
    () => () => {
      generation.current += 1;
      fading.current = false;
      window.clearTimeout(settleTimer.current);
      first.current?.pause();
      second.current?.pause();
    },
    [],
  );

  useEffect(() => {
    const video = (active.current === 0 ? first : second).current;
    if (!video) return;
    if (!paused) {
      void Promise.resolve(video.play()).catch(() => undefined);
    }
  }, [paused]);

  const onTimeUpdate = (index: number) => {
    if (index !== active.current || paused) return;
    const video = slots[index].current;
    if (!video) return;
    if (!warm && video.currentTime > 2) setWarm(true);
    const { duration } = video;
    if (!Number.isFinite(duration) || duration < FADE * 3) return;
    if (video.currentTime >= duration - FADE - LEAD) crossfade();
  };
  const onEnded = (index: number) => {
    if (index !== active.current) return;
    if (fading.current) return;
    crossfade();
  };

  return (
    <div
      className={`living-background-media living-background-loop${playing ? " is-playing" : ""}${
        drift ? " is-drifting" : ""
      }`}
    >
      {slots.map((ref, index) => (
        <video
          key={index}
          ref={ref}
          className={`living-background-video is-${states[index]}`}
          src={src}
          autoPlay={index === 0 && !paused}
          preload={index === 0 || warm ? "auto" : "none"}
          muted
          playsInline
          disablePictureInPicture
          onPlaying={index === 0 ? () => setPlaying(true) : undefined}
          onTimeUpdate={() => onTimeUpdate(index)}
          onEnded={() => onEnded(index)}
          onError={() => {
            if (index === active.current) onError();
          }}
        />
      ))}
    </div>
  );
}

interface SceneDriver {
  resize(): void;
  start(): void;
  stop(): void;
  renderOnce(): void;
  destroy(): void;
}

async function loadDriver(canvas: HTMLCanvasElement, background: BackgroundDefinition, lowPower: boolean): Promise<SceneDriver | null> {
  if (background.kind === "glyph") {
    const { createGlyphEngine } = await import("../glyph/glyphScenes");
    const engine = createGlyphEngine(canvas, { lowPower });
    engine.select(background.scene ?? "");
    return engine;
  }
  if (background.kind === "ambient" && background.style && background.palette) {
    const [{ createAmbientEngine }, { getAmbientPalette, hashSeed }] = await Promise.all([
      import("../ambient/ambientEngine"),
      import("../ambient/ambientPresets"),
    ]);
    const palette = getAmbientPalette(background.palette);
    if (!palette) return null;
    return createAmbientEngine(canvas, { style: background.style, palette, seed: hashSeed(background.id) }, { lowPower });
  }
  return null;
}

/** Shared canvas host for glyph and ambient scenes. One engine per layer. */
function SceneCanvas({
  background,
  lowPower,
  still,
  paused,
}: {
  background: BackgroundDefinition;
  lowPower: boolean;
  still: boolean;
  paused: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<SceneDriver | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext("2d")) return;
    let cancelled = false;
    loadDriver(canvas, background, lowPower).then(
      (driver) => {
        if (!driver) return;
        // A stale engine must not take over a canvas that has moved on.
        if (cancelled || canvasRef.current !== canvas) {
          driver.destroy();
          return;
        }
        driverRef.current = driver;
        setReady(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      driverRef.current?.destroy();
      driverRef.current = null;
      setReady(false);
    };
  }, [background, lowPower]);

  useEffect(() => {
    const driver = driverRef.current;
    if (!ready || !driver) return;
    if (still) {
      driver.stop();
      driver.renderOnce();
    } else if (paused) driver.stop();
    else driver.start();
  }, [ready, still, paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        driverRef.current?.resize();
        if (still) driverRef.current?.renderOnce();
      }, 150);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    if (observer) observer.observe(canvas);
    else window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [ready, still]);

  return <canvas ref={canvasRef} className="living-background-media living-background-canvas" />;
}
