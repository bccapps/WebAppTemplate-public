/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { useCallback, useEffect, useRef, useState } from 'react';
import { rmsLevel } from './audioMath';
import { toMonoWavFile } from './audioDecode';

export type MicRecorderState = 'idle' | 'requesting' | 'recording' | 'processing' | 'denied' | 'no-device' | 'error' | 'unsupported';

export interface MicRecording {
  /** The recording as captured (webm/ogg/mp4 depending on the browser). */
  blob: Blob;
  /** Mono 16-bit WAV conversion; null when decoding failed (use `blob`). */
  wav: File | null;
  seconds: number;
}

export interface MicRecorderOptions {
  onDone: (recording: MicRecording) => void;
  /** Base name of the WAV file. */
  fileName?: string;
  /** Convert to mono WAV after recording (default true). */
  toWav?: boolean;
}

/** Maps a `getUserMedia` failure to a recorder state. */
export function classifyMicError(error: unknown): 'denied' | 'no-device' | 'error' {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no-device';
  return 'error';
}

interface Session {
  recorder?: MediaRecorder;
  stream?: MediaStream;
  ctx?: AudioContext;
  raf?: number;
  timer?: ReturnType<typeof setInterval>;
  cancelled?: boolean;
}

const isSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

/**
 * Microphone recording with a live level meter (0..1) and mono WAV conversion. Permission refusals and missing
 * devices become states (`denied`, `no-device`), never exceptions. Tracks and the audio context are released
 * on stop, cancel and unmount.
 */
export function useMicRecorder({ onDone, fileName = 'recording', toWav = true }: MicRecorderOptions) {
  const [state, setState] = useState<MicRecorderState>(isSupported() ? 'idle' : 'unsupported');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const session = useRef<Session>({});
  const mounted = useRef(true);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const release = useCallback(() => {
    const s = session.current;
    if (s.raf !== undefined) cancelAnimationFrame(s.raf);
    if (s.timer) clearInterval(s.timer);
    s.stream?.getTracks().forEach((t) => t.stop());
    s.ctx?.close().catch(() => undefined);
    session.current = {};
    if (mounted.current) setLevel(0);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      session.current.cancelled = true;
      const recorder = session.current.recorder;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      release();
    };
  }, [release]);

  const finish = useCallback(
    async (blob: Blob, elapsed: number) => {
      let wav: File | null = null;
      if (toWav) wav = await toMonoWavFile(blob, fileName).catch(() => null);
      if (!mounted.current) return;
      setState('idle');
      doneRef.current({ blob, wav, seconds: elapsed });
    },
    [fileName, toWav],
  );

  const start = useCallback(async () => {
    if (!isSupported()) return setState('unsupported');
    if (session.current.recorder || state === 'requesting') return;
    setState('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, channelCount: 1 } });
    } catch (error) {
      if (mounted.current) setState(classifyMicError(error));
      return;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const current: Session = { stream };
    session.current = current;
    try {
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      const t0 = Date.now();
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      recorder.onstop = () => {
        const elapsed = (Date.now() - t0) / 1000;
        const cancelled = current.cancelled;
        release();
        if (cancelled) return mounted.current && setState('idle');
        setState('processing');
        void finish(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), elapsed);
      };
      current.recorder = recorder;
      startMeter(current, setLevel);
      current.timer = setInterval(() => setSeconds((Date.now() - t0) / 1000), 200);
      setSeconds(0);
      recorder.start();
      setState('recording');
    } catch {
      release();
      setState('error');
    }
  }, [finish, release, state]);

  const stop = useCallback(() => {
    const recorder = session.current.recorder;
    if (recorder && recorder.state === 'recording') recorder.stop();
  }, []);

  /** Stops and discards the recording (`onDone` is not called). */
  const cancel = useCallback(() => {
    session.current.cancelled = true;
    const recorder = session.current.recorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else release();
  }, [release]);

  /** Leaves a `denied` / `no-device` / `error` state. */
  const reset = useCallback(() => setState(isSupported() ? 'idle' : 'unsupported'), []);

  return { state, seconds, level, start, stop, cancel, reset };
}

function startMeter(session: Session, setLevel: (level: number) => void): void {
  if (!session.stream || typeof AudioContext === 'undefined') return;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(session.stream).connect(analyser);
  session.ctx = ctx;
  const buffer = new Float32Array(analyser.fftSize);
  const loop = () => {
    analyser.getFloatTimeDomainData(buffer);
    setLevel(rmsLevel(buffer));
    session.raf = requestAnimationFrame(loop);
  };
  loop();
}
