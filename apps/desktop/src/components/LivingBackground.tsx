import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getActiveBackground, subscribeBackground } from "../background";
import type { BackgroundDefinition } from "../backgroundCatalog";
import { loadBackgroundVideo } from "../backgroundVideo";
import type { GlyphEngine } from "../glyph/glyphScenes";

function subscribeReducedMotion(listener: () => void) {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  query?.addEventListener?.("change", listener);
  return () => query?.removeEventListener?.("change", listener);
}
const prefersReducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * Fixed layer behind the app shell. Video wallpapers show their bundled cover
 * immediately, then fade in the cached loop; glyph scenes animate on a canvas.
 * Respects prefers-reduced-motion (still cover / single frame) and pauses while hidden.
 */
export function LivingBackground() {
  const background = useSyncExternalStore(subscribeBackground, getActiveBackground);
  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  if (background.kind === "none") return null;
  return (
    <div
      className={`living-background${background.light ? " is-light" : ""}`}
      data-kind={background.kind}
      aria-hidden="true"
    >
      {background.kind === "video" ? (
        <VideoWallpaper key={background.id} background={background} reduceMotion={reduceMotion} />
      ) : (
        <GlyphCanvas scene={background.scene ?? ""} reduceMotion={reduceMotion} />
      )}
      <div className="living-background-scrim" />
    </div>
  );
}

function VideoWallpaper({ background, reduceMotion }: { background: BackgroundDefinition; reduceMotion: boolean }) {
  const [source, setSource] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (reduceMotion || !background.video) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    loadBackgroundVideo(background.video).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      },
      // Offline or CDN failure: the bundled cover stays as the wallpaper.
      () => undefined,
    );
    return () => {
      cancelled = true;
      setSource(undefined);
      setPlaying(false);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [background.video, reduceMotion]);

  useEffect(() => {
    const onVisibility = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) video.pause();
      else void video.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <>
      {background.poster && (
        <img className="living-background-media living-background-poster" src={background.poster} alt="" draggable={false} />
      )}
      {source && (
        <video
          ref={videoRef}
          className={`living-background-media living-background-video${playing ? " is-playing" : ""}`}
          src={source}
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          onPlaying={() => setPlaying(true)}
          onError={() => setSource(undefined)}
        />
      )}
    </>
  );
}

function GlyphCanvas({ scene, reduceMotion }: { scene: string; reduceMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GlyphEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext("2d")) return;
    const run = (engine: GlyphEngine) => {
      engine.select(scene);
      if (reduceMotion) {
        engine.stop();
        engine.renderOnce();
      } else if (!document.hidden) {
        engine.start();
      }
    };
    if (engineRef.current) run(engineRef.current);
    else {
      void import("../glyph/glyphScenes").then(({ createGlyphEngine }) => {
        if (cancelled || canvasRef.current !== canvas) return;
        engineRef.current = createGlyphEngine(canvas);
        run(engineRef.current);
      });
    }
    return () => {
      cancelled = true;
      engineRef.current?.stop();
    };
  }, [scene, reduceMotion]);

  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        engineRef.current?.resize();
        if (prefersReducedMotion()) engineRef.current?.renderOnce();
      }, 150);
    };
    const onVisibility = () => {
      const engine = engineRef.current;
      if (!engine) return;
      if (document.hidden || prefersReducedMotion()) engine.stop();
      else engine.start();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="living-background-media living-background-canvas" />;
}
