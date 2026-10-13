/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


export { Waveform, WaveformPending } from './Waveform';
export type { WaveformProps, WaveformPendingProps } from './Waveform';
export { AudioPlayer } from './AudioPlayer';
export type { AudioPlayerProps } from './AudioPlayer';
export { getSharedAudioPlayer, useSharedAudioPlayer } from './useSharedAudioPlayer';
export type { SharedAudioPlayer } from './useSharedAudioPlayer';
export { createSharedPlayerStore } from './sharedPlayerStore';
export type { AudioElementLike, SharedPlayerOptions, SharedPlayerState, SharedPlayerStore } from './sharedPlayerStore';
export { classifyMicError, useMicRecorder } from './useMicRecorder';
export type { MicRecorderOptions, MicRecorderState, MicRecording } from './useMicRecorder';
export { readAudioPeaks, toMonoWavFile } from './audioDecode';
export { computePeaks, downmixToMono, encodeWavMono, fractionInBox, rmsLevel, seekFractionForKey } from './audioMath';
export { Lightbox } from './Lightbox';
export type { LightboxItem, LightboxProps } from './Lightbox';
export { clampIndex, counterText, lightboxKeyAction, stepIndex } from './lightboxNav';
export type { LightboxKeyAction } from './lightboxNav';
export { VideoPoster } from './VideoPoster';
export type { VideoPosterProps } from './VideoPoster';
export { posterAspectRatio } from './posterAspect';
