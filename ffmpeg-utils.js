const { spawn, execSync } = require('child_process');

const activeStreams = new Map();

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000; // 5 seconds between retries

function checkFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function buildFfmpegArgs(filePath, config) {
  const args = [];

  // Input options (before -i)
  args.push('-re'); // Read input at native frame rate

  // Loop: -1 = infinite, 0 = no loop, N = loop N times
  if (config.loop || config.loopCount === -1) {
    args.push('-stream_loop', '-1');
  } else if (config.loopCount > 1) {
    args.push('-stream_loop', String(config.loopCount - 1));
  }

  // Trim start
  if (config.startTime && config.startTime > 0) {
    args.push('-ss', String(config.startTime));
  }

  // Trim duration (input-side: endTime - startTime)
  // Only apply when NOT looping, because -t before -i limits total input
  // read time which prevents -stream_loop from working
  const isLooping = config.loop || config.loopCount === -1 || config.loopCount > 1;
  if (!isLooping && config.endTime && config.startTime != null && config.endTime > config.startTime) {
    args.push('-t', String(config.endTime - config.startTime));
  }

  // Input file
  args.push('-i', filePath);

  // Video codec
  args.push('-c:v', 'libx264');
  args.push('-preset', 'veryfast');
  args.push('-tune', 'zerolatency');

  // Video filters
  const filters = [];

  // Resolution scaling
  if (config.resolution && config.resolution !== 'source') {
    const resMap = {
      '1080p': '1920:1080',
      '720p': '1280:720',
      '480p': '854:480',
    };
    if (resMap[config.resolution]) {
      filters.push(`scale=${resMap[config.resolution]}`);
    }
  }

  // Aspect ratio
  if (config.aspectRatio && config.aspectRatio !== 'source') {
    const ratioMap = {
      '16:9': '16/9',
      '9:16': '9/16',
      '1:1': '1/1',
      '4:3': '4/3',
    };
    if (ratioMap[config.aspectRatio]) {
      filters.push(`setdar=${ratioMap[config.aspectRatio]}`);
    }
  }

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  // Framerate
  if (config.frameRate && config.frameRate !== 'source') {
    args.push('-r', String(config.frameRate));
  }

  // Bitrate
  if (config.bitrate && config.bitrate !== 'auto') {
    args.push('-b:v', `${config.bitrate}k`);
    args.push('-maxrate', `${config.bitrate}k`);
    args.push('-bufsize', `${Math.round(config.bitrate * 2)}k`);
  } else {
    args.push('-b:v', '4500k');
    args.push('-maxrate', '4500k');
    args.push('-bufsize', '9000k');
  }

  // Audio codec
  args.push('-c:a', 'aac');
  args.push('-b:a', '128k');
  args.push('-ar', '44100');

  // Output duration cap (minutes -> seconds) — applied as output option
  if (config.duration && config.duration > 0) {
    args.push('-t', String(config.duration * 60));
  }

  // Output format + destination
  args.push('-f', 'flv');

  const rtmpDest = config.streamKey
    ? `${config.rtmpUrl.replace(/\/$/, '')}/${config.streamKey}`
    : config.rtmpUrl;
  args.push(rtmpDest);

  return args;
}

function spawnFfmpeg(streamId, filePath, config, streamState) {
  const args = buildFfmpegArgs(filePath, config);

  console.log(`[Stream ${streamId}] Starting FFmpeg (attempt ${streamState.reconnectAttempts + 1}):`, 'ffmpeg', args.join(' '));

  const proc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  streamState.process = proc;
  streamState.status = 'running';

  // Parse stderr for progress
  proc.stderr.on('data', (data) => {
    const output = data.toString();

    // Extract time=HH:MM:SS.xx
    const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2})/);
    if (timeMatch) {
      streamState.stats.time = timeMatch[1];
      // Reset reconnect attempts on successful progress (stream is working)
      streamState.reconnectAttempts = 0;

      // Estimate loop count from elapsed time vs clip duration
      if (config.endTime && config.startTime != null) {
        const clipDuration = config.endTime - config.startTime;
        if (clipDuration > 0) {
          const parts = timeMatch[1].split(':').map(Number);
          const elapsed = parts[0] * 3600 + parts[1] * 60 + parts[2];
          streamState.stats.loopCount = Math.floor(elapsed / clipDuration) + 1;
        }
      }
    }
  });

  proc.on('close', (code) => {
    console.log(`[Stream ${streamId}] FFmpeg exited with code ${code}`);

    // Only reconnect if the stream wasn't manually stopped
    if (streamState.status === 'running' && code !== 0) {
      if (streamState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        streamState.reconnectAttempts++;
        streamState.status = 'reconnecting';
        console.log(`[Stream ${streamId}] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (attempt ${streamState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        streamState.reconnectTimer = setTimeout(() => {
          if (streamState.status === 'reconnecting') {
            spawnFfmpeg(streamId, filePath, config, streamState);
          }
        }, RECONNECT_DELAY_MS);
      } else {
        console.log(`[Stream ${streamId}] Max reconnect attempts reached. Giving up.`);
        streamState.status = 'error';
      }
    } else if (streamState.status === 'running' && code === 0) {
      streamState.status = 'completed';
    }
  });

  proc.on('error', (err) => {
    console.error(`[Stream ${streamId}] FFmpeg error:`, err.message);
    // Let the 'close' handler deal with reconnection
  });
}

function startStream(streamId, filePath, config) {
  const streamState = {
    process: null,
    status: 'running',
    startedAt: Date.now(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    stats: {
      time: '00:00:00',
      loopCount: 1,
    },
    config,
  };

  activeStreams.set(streamId, streamState);
  spawnFfmpeg(streamId, filePath, config, streamState);

  return streamId;
}

function stopStream(streamId) {
  const stream = activeStreams.get(streamId);
  if (!stream || (stream.status !== 'running' && stream.status !== 'reconnecting')) {
    return false;
  }

  stream.status = 'stopped';

  // Cancel any pending reconnect
  if (stream.reconnectTimer) {
    clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
  }

  // Kill the FFmpeg process if it's still running
  if (stream.process && !stream.process.killed) {
    stream.process.kill('SIGINT');

    // Force kill after 5 seconds if still alive
    const killTimeout = setTimeout(() => {
      try {
        stream.process.kill('SIGKILL');
      } catch {
        // Process already exited
      }
    }, 5000);

    stream.process.on('close', () => {
      clearTimeout(killTimeout);
    });
  }

  return true;
}

function getStreamStatus(streamId) {
  const stream = activeStreams.get(streamId);
  if (!stream) {
    return { status: 'not_found', stats: {} };
  }
  return {
    // Report 'reconnecting' as 'running' so the frontend keeps polling
    status: stream.status === 'reconnecting' ? 'running' : stream.status,
    reconnecting: stream.status === 'reconnecting',
    reconnectAttempt: stream.reconnectAttempts,
    stats: { ...stream.stats },
  };
}

function stopAllStreams() {
  for (const [id, stream] of activeStreams) {
    if (stream.status === 'running' || stream.status === 'reconnecting') {
      console.log(`[Shutdown] Stopping stream ${id}`);
      if (stream.reconnectTimer) {
        clearTimeout(stream.reconnectTimer);
      }
      try {
        if (stream.process && !stream.process.killed) {
          stream.process.kill('SIGKILL');
        }
      } catch {
        // Ignore
      }
      stream.status = 'stopped';
    }
  }
}

module.exports = {
  checkFfmpeg,
  buildFfmpegArgs,
  startStream,
  stopStream,
  getStreamStatus,
  stopAllStreams,
};
