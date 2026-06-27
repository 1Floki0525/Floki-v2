'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  getModelConfig,
  getDetectionConfig: getYamlDetectionConfig
} = require('../config/floki-config.cjs');

const verificationCache = new Map();
const verificationTracks = [];
let endpointHealth = Object.freeze({
  checkedAt: 0,
  endpoint: null,
  model: null
});

const CLASSIFICATIONS = new Set([
  'live_person',
  'depicted_person',
  'uncertain'
]);

const DEPICTION_TYPES = new Set([
  'none',
  'framed_photo',
  'poster',
  'screen',
  'artwork',
  'printed_image',
  'unknown'
]);

function parseClassConfidenceOverrides(raw) {
  if (!raw || typeof raw !== 'object') return Object.freeze({});
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    const threshold = Number(value);
    if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
      result[String(key).toLowerCase().trim()] = threshold;
    }
  }
  return Object.freeze(result);
}

function getPersonVerifierConfig() {
  const detection = getYamlDetectionConfig('chat');

  return Object.freeze({
    enabled: detection.person_verifier_enabled !== false,
    timeoutMs: Math.max(
      1000,
      Number(detection.person_verifier_timeout_ms || 30000)
    ),
    maxCandidates: Math.max(
      1,
      Number(detection.person_verifier_max_candidates_per_frame || 4)
    ),
    maxDinoOnlyCandidates: 0,
    minDinoOnlyArea: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_verifier_min_dino_only_area || 0.02)
      )
    ),
    cropPaddingRatio: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_verifier_crop_padding_ratio || 0.35)
      )
    ),
    cropMaxDimension: Math.max(
      128,
      Math.min(
        1024,
        Number(detection.person_verifier_crop_max_dimension || 512)
      )
    ),
    cropJpegQuality: Math.max(
      2,
      Math.min(
        31,
        Number(detection.person_verifier_crop_jpeg_quality || 5)
      )
    ),
    cacheTtlMs: Math.max(
      1000,
      Number(detection.person_verifier_cache_ttl_ms || 60000)
    ),
    trackTtlMs: Math.max(
      500,
      Number(detection.person_verifier_track_ttl_ms || 3000)
    ),
    minConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_verifier_min_confidence || 0.65)
      )
    ),
    objectDisplayMinConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(detection.object_display_min_confidence || 0.55)
      )
    ),
    objectConsensusMinConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(detection.object_consensus_min_confidence || 0.35)
      )
    ),
    dinoOnlyObjectDisplayMinConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(
          detection.grounding_dino_object_display_min_confidence ||
          0.35
        )
      )
    ),
    personConsensusDisplayMinConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(
          detection.person_consensus_display_min_confidence ||
          0.35
        )
      )
    ),
    groupingIouThreshold: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_verifier_grouping_iou_threshold || 0.25)
      )
    ),
    trackIouThreshold: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_verifier_track_iou_threshold || 0.30)
      )
    ),
    trackCenterDistance: Math.max(
      0,
      Math.min(
        2,
        Number(detection.person_verifier_track_center_distance || 0.12)
      )
    ),
    classMinConfidenceOverrides: parseClassConfidenceOverrides(
      detection.class_min_confidence_overrides
    ),
    personTrackMinCandidateConfidence: Math.max(
      0,
      Math.min(
        1,
        Number(detection.person_track_min_candidate_confidence || 0.20)
      )
    )
  });
}

function proposalSources(detection) {
  const raw = Array.isArray(detection && detection.proposal_sources)
    ? detection.proposal_sources
    : [detection && detection.source];

  return [...new Set(
    raw
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

function hasYoloSupport(detection) {
  return proposalSources(detection).includes('yolo');
}

function hasGroundingDinoSupport(detection) {
  return proposalSources(detection).includes('grounding_dino');
}

function isPersonCandidate(detection) {
  if (!detection || typeof detection !== 'object') return false;

  const label = String(
    detection.label || detection.type || ''
  ).trim().toLowerCase();

  return (
    Number(detection.class_id) === 0 ||
    label === 'person' ||
    label === 'human' ||
    label === 'human person' ||
    label.includes('human person')
  );
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedBox(detection) {
  const box = detection && detection.bbox
    ? detection.bbox
    : {};

  const x = clamp(Number(box.x || 0), 0, 1);
  const y = clamp(Number(box.y || 0), 0, 1);
  const width = clamp(Number(box.width || 0), 0, 1 - x);
  const height = clamp(Number(box.height || 0), 0, 1 - y);

  return Object.freeze({ x, y, width, height });
}

function boxArea(detectionOrBox) {
  const box = detectionOrBox && detectionOrBox.bbox
    ? normalizedBox(detectionOrBox)
    : normalizedBox({ bbox: detectionOrBox });

  return Math.max(0, box.width) * Math.max(0, box.height);
}

function boxIou(leftValue, rightValue) {
  const left = leftValue && leftValue.bbox
    ? normalizedBox(leftValue)
    : normalizedBox({ bbox: leftValue });
  const right = rightValue && rightValue.bbox
    ? normalizedBox(rightValue)
    : normalizedBox({ bbox: rightValue });

  const leftX2 = left.x + left.width;
  const leftY2 = left.y + left.height;
  const rightX2 = right.x + right.width;
  const rightY2 = right.y + right.height;

  const intersectionWidth = Math.max(
    0,
    Math.min(leftX2, rightX2) - Math.max(left.x, right.x)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftY2, rightY2) - Math.max(left.y, right.y)
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union = boxArea(left) + boxArea(right) - intersection;

  return union > 0 ? intersection / union : 0;
}

function boxCenterDistance(leftValue, rightValue) {
  const left = leftValue && leftValue.bbox
    ? normalizedBox(leftValue)
    : normalizedBox({ bbox: leftValue });
  const right = rightValue && rightValue.bbox
    ? normalizedBox(rightValue)
    : normalizedBox({ bbox: rightValue });

  const leftX = left.x + left.width / 2;
  const leftY = left.y + left.height / 2;
  const rightX = right.x + right.width / 2;
  const rightY = right.y + right.height / 2;

  return Math.hypot(leftX - rightX, leftY - rightY);
}

function unionBoxes(detections) {
  const boxes = detections.map(normalizedBox);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return Object.freeze({
    x: clamp(left, 0, 1),
    y: clamp(top, 0, 1),
    width: clamp(right - left, 0, 1 - left),
    height: clamp(bottom - top, 0, 1 - top)
  });
}

function mergePersonCandidateGroup(entries) {
  const detections = entries.map((entry) => entry.detection);
  const sources = [...new Set(
    detections.flatMap(proposalSources)
  )];

  const representative = detections
    .slice()
    .sort((left, right) => {
      const supportDifference =
        Number(hasYoloSupport(right)) -
        Number(hasYoloSupport(left));

      if (supportDifference !== 0) return supportDifference;

      return (
        Number(right.confidence || 0) -
        Number(left.confidence || 0)
      );
    })[0];

  return Object.freeze({
    outputIndexes: Object.freeze(
      entries.map((entry) => entry.outputIndex)
    ),
    originalDetections: Object.freeze(detections),
    detection: Object.freeze({
      ...representative,
      class_id: 0,
      type: 'person',
      label: 'person',
      confidence: Math.max(
        ...detections.map((detection) =>
          Number(detection.confidence || 0)
        )
      ),
      source: sources.includes('yolo')
        ? 'yolo'
        : 'grounding_dino',
      proposal_sources: Object.freeze(sources),
      proposal_phrase: detections
        .map((detection) =>
          String(
            detection.proposal_phrase ||
            detection.label ||
            ''
          ).trim()
        )
        .filter(Boolean)
        .join(' | '),
      visual_fingerprint:
        detections.find((detection) =>
          String(detection.visual_fingerprint || '').trim()
        )?.visual_fingerprint || null,
      bbox: unionBoxes(detections)
    })
  });
}

function buildPersonCandidateGroups(detections) {
  const config = getPersonVerifierConfig();
  const entries = [];

  for (let index = 0; index < detections.length; index += 1) {
    const detection = detections[index];
    if (!isPersonCandidate(detection)) continue;

    entries.push(Object.freeze({
      outputIndex: index,
      detection
    }));
  }

  const groups = [];

  for (const entry of entries) {
    let group = null;

    for (const existing of groups) {
      const overlaps = existing.entries.some((member) =>
        boxIou(member.detection, entry.detection) >=
        config.groupingIouThreshold
      );

      if (overlaps) {
        group = existing;
        break;
      }
    }

    if (group) {
      group.entries.push(entry);
    } else {
      groups.push({ entries: [entry] });
    }
  }

  return groups
    .map((group) => mergePersonCandidateGroup(group.entries))
    .sort((left, right) => {
      const leftDetection = left.detection;
      const rightDetection = right.detection;

      const supportDifference =
        Number(hasYoloSupport(rightDetection)) -
        Number(hasYoloSupport(leftDetection));

      if (supportDifference !== 0) return supportDifference;

      const consensusDifference =
        Number(
          hasYoloSupport(rightDetection) &&
          hasGroundingDinoSupport(rightDetection)
        ) -
        Number(
          hasYoloSupport(leftDetection) &&
          hasGroundingDinoSupport(leftDetection)
        );

      if (consensusDifference !== 0) return consensusDifference;

      const areaDifference =
        boxArea(rightDetection) -
        boxArea(leftDetection);

      if (areaDifference !== 0) return areaDifference;

      return (
        Number(rightDetection.confidence || 0) -
        Number(leftDetection.confidence || 0)
      );
    });
}

function selectPersonCandidateGroups(detections) {
  const config = getPersonVerifierConfig();

  return Object.freeze(
    buildPersonCandidateGroups(detections)
      .filter((group) => hasYoloSupport(group.detection))
      .slice(0, config.maxCandidates)
  );
}

function paddedCrop(
  detection,
  imageWidth,
  imageHeight,
  paddingRatio
) {
  const bbox = normalizedBox(detection);
  const padX = bbox.width * paddingRatio;
  const padY = bbox.height * paddingRatio;

  const left = clamp(bbox.x - padX, 0, 1);
  const top = clamp(bbox.y - padY, 0, 1);
  const right = clamp(
    bbox.x + bbox.width + padX,
    0,
    1
  );
  const bottom = clamp(
    bbox.y + bbox.height + padY,
    0,
    1
  );

  return Object.freeze({
    x: Math.floor(left * imageWidth),
    y: Math.floor(top * imageHeight),
    width: Math.max(
      2,
      Math.floor((right - left) * imageWidth)
    ),
    height: Math.max(
      2,
      Math.floor((bottom - top) * imageHeight)
    )
  });
}

function cropFrameBufferFromBuffer(
  frameBuffer,
  detection,
  imageWidth,
  imageHeight,
  paddingRatio,
  options = {}
) {
  const config = getPersonVerifierConfig();
  const crop = paddedCrop(
    detection,
    imageWidth,
    imageHeight,
    paddingRatio
  );
  const maxDimension = Math.max(
    128,
    Number(options.max_dimension || config.cropMaxDimension)
  );
  const jpegQuality = Math.max(
    2,
    Math.min(
      31,
      Number(options.jpeg_quality || config.cropJpegQuality)
    )
  );
  const filter = [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    `scale=w='if(gt(iw,${maxDimension}),${maxDimension},iw)':h=-2:flags=lanczos`
  ].join(',');

  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vf', filter,
    '-frames:v', '1',
    '-q:v', String(jpegQuality),
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ], {
    input: frameBuffer,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000
  });

  if (
    result.status !== 0 ||
    !result.stdout ||
    result.stdout.length === 0
  ) {
    const stderr = result.stderr
      ? result.stderr.toString('utf8').trim()
      : '';

    throw new Error(
      'person candidate crop failed' +
      (stderr ? ': ' + stderr : '')
    );
  }

  return result.stdout;
}

function verificationCacheKey(detection, cropBuffer = null) {
  const fingerprint = String(
    detection && detection.visual_fingerprint || ''
  ).trim();

  if (fingerprint) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        visual_fingerprint: fingerprint,
        class_id: Number(detection.class_id)
      }))
      .digest('hex')
      .slice(0, 32);
  }

  if (!cropBuffer) return null;

  return crypto
    .createHash('sha256')
    .update(cropBuffer)
    .digest('hex')
    .slice(0, 32);
}

function validateVerificationResult(value) {
  if (!value || typeof value !== 'object') {
    return {
      valid: false,
      error: 'verification must be an object'
    };
  }

  if (!Number.isInteger(Number(value.candidate_index))) {
    return {
      valid: false,
      error: 'candidate_index must be an integer'
    };
  }

  if (!CLASSIFICATIONS.has(value.classification)) {
    return {
      valid: false,
      error: 'invalid classification'
    };
  }

  const confidence = Number(value.confidence);

  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      valid: false,
      error: 'confidence must be 0-1'
    };
  }

  if (!DEPICTION_TYPES.has(value.depiction_type)) {
    return {
      valid: false,
      error: 'invalid depiction_type'
    };
  }

  if (
    typeof value.short_basis !== 'string' ||
    value.short_basis.trim().length === 0 ||
    value.short_basis.length > 240
  ) {
    return {
      valid: false,
      error: 'short_basis must be 1-240 characters'
    };
  }

  if (
    value.classification === 'live_person' &&
    value.depiction_type !== 'none'
  ) {
    return {
      valid: false,
      error: 'live_person requires depiction_type none'
    };
  }

  return { valid: true };
}

function normalizeVerificationResult(value, minConfidence) {
  const validation = validateVerificationResult(value);

  if (!validation.valid) {
    return Object.freeze({
      candidate_index: Number.isInteger(
        Number(value && value.candidate_index)
      )
        ? Number(value.candidate_index)
        : -1,
      classification: 'uncertain',
      confidence: 0,
      depiction_type: 'unknown',
      short_basis: validation.error,
      verifier_ok: false
    });
  }

  if (
    value.classification !== 'uncertain' &&
    Number(value.confidence) < minConfidence
  ) {
    return Object.freeze({
      candidate_index: Number(value.candidate_index),
      classification: 'uncertain',
      confidence: Number(value.confidence),
      depiction_type: 'unknown',
      short_basis:
        'verification confidence below strict threshold',
      verifier_ok: false
    });
  }

  return Object.freeze({
    candidate_index: Number(value.candidate_index),
    classification: value.classification,
    confidence: Number(value.confidence),
    depiction_type: value.depiction_type,
    short_basis: value.short_basis.trim(),
    verifier_ok: value.classification !== 'uncertain'
  });
}

function depictedLabel(depictionType) {
  const labels = {
    framed_photo: 'framed photo',
    poster: 'poster',
    screen: 'screen image',
    artwork: 'artwork',
    printed_image: 'printed image',
    unknown: 'depicted person'
  };

  return labels[depictionType] || 'depicted person';
}

function dinoOnlyObjectRequiresVerification(detection) {
  return (
    !isPersonCandidate(detection) &&
    hasGroundingDinoSupport(detection) &&
    !hasYoloSupport(detection)
  );
}

function classifyVerifiedDetectionForDisplay(detection) {
  if (!isPersonCandidate(detection)) {
    const config = getPersonVerifierConfig();
    const sources = proposalSources(detection);
    const confidence = Number(
      detection && detection.confidence || 0
    );
    const yoloSupported = sources.includes('yolo');
    const dinoSupported = sources.includes('grounding_dino');

    if (!yoloSupported && dinoSupported) {
      if (
        confidence <
        config.dinoOnlyObjectDisplayMinConfidence
      ) {
        return Object.freeze({
          bucket: 'suppressed',
          detection,
          unavailable_reason:
            'grounding_dino_object_below_display_threshold'
        });
      }

      const dinoNormalizedLabel = String(
        detection.label || detection.type || ''
      ).replace(/^a\s+/i, '').trim().toLowerCase();
      const dinoClassMin =
        config.classMinConfidenceOverrides[dinoNormalizedLabel] ??
        config.classMinConfidenceOverrides[
          String(detection.label || '').toLowerCase().trim()
        ];
      if (dinoClassMin !== undefined && confidence < dinoClassMin) {
        return Object.freeze({
          bucket: 'suppressed',
          detection,
          unavailable_reason: 'class_confidence_below_class_minimum'
        });
      }

      return Object.freeze({
        bucket: 'objects',
        detection: Object.freeze({
          ...detection,
          type: 'object',
          label: String(
            detection.label || detection.type || 'object'
          ).replace(/^a\s+/i, '').trim(),
          display_basis: 'grounding_dino_open_vocabulary'
        })
      });
    }

    if (!yoloSupported) {
      return Object.freeze({
        bucket: 'suppressed',
        detection,
        unavailable_reason:
          'object_detection_source_unavailable'
      });
    }

    const threshold = dinoSupported
      ? config.objectConsensusMinConfidence
      : config.objectDisplayMinConfidence;

    if (confidence < threshold) {
      return Object.freeze({
        bucket: 'suppressed',
        detection,
        unavailable_reason:
          'object_detection_confidence_below_display_threshold'
      });
    }

    const yoloNormalizedLabel = String(
      detection.label || ''
    ).toLowerCase().trim();
    const yoloClassMin =
      config.classMinConfidenceOverrides[yoloNormalizedLabel];
    if (yoloClassMin !== undefined && confidence < yoloClassMin) {
      return Object.freeze({
        bucket: 'suppressed',
        detection,
        unavailable_reason: 'class_confidence_below_class_minimum'
      });
    }

    return Object.freeze({
      bucket: 'objects',
      detection
    });
  }

  const verification = detection && detection.verification;
  const config = getPersonVerifierConfig();
  const sources = proposalSources(detection);
  const confidence = Number(
    detection && detection.confidence || 0
  );
  const consensusPerson =
    sources.includes('yolo') &&
    sources.includes('grounding_dino') &&
    confidence >=
      config.personConsensusDisplayMinConfidence;

  if (
    !verification ||
    verification.verifier_ok !== true ||
    verification.classification === 'uncertain'
  ) {
    // A YOLO + Grounding DINO agreement is allowed as a visible provisional
    // person track while the crop verifier completes or recovers. DINO-only
    // wall photos and YOLO-only guesses remain hidden.
    if (consensusPerson) {
      return Object.freeze({
        bucket: 'persons',
        detection: Object.freeze({
          ...detection,
          type: 'person',
          label: 'person',
          display_basis: 'yolo_grounding_dino_consensus',
          verification_status: verification
            ? 'verifier_unavailable'
            : 'verification_pending'
        })
      });
    }

    return Object.freeze({
      bucket: 'suppressed',
      detection,
      unavailable_reason: !verification
        ? 'person_verification_pending'
        : String(
            verification.short_basis ||
            'person_verification_unavailable'
          )
    });
  }

  if (verification.classification === 'live_person') {
    if (
      verification.cache_source === 'spatial_track' &&
      confidence < config.personTrackMinCandidateConfidence
    ) {
      return Object.freeze({
        bucket: 'suppressed',
        detection,
        unavailable_reason: 'person_track_confidence_below_minimum'
      });
    }
    return Object.freeze({
      bucket: 'persons',
      detection: Object.freeze({
        ...detection,
        type: 'person',
        label: 'person'
      })
    });
  }

  if (verification.classification === 'depicted_person') {
    return Object.freeze({
      bucket: 'objects',
      detection: Object.freeze({
        ...detection,
        type: 'object',
        label: depictedLabel(verification.depiction_type),
        original_yolo_label: 'person'
      })
    });
  }

  return Object.freeze({
    bucket: 'suppressed',
    detection,
    unavailable_reason:
      'unsupported_person_verification_result'
  });
}

function pruneVerificationState(now = Date.now()) {
  for (const [key, cached] of verificationCache.entries()) {
    if (!cached || cached.expiresAt <= now) {
      verificationCache.delete(key);
    }
  }

  for (let index = verificationTracks.length - 1; index >= 0; index -= 1) {
    if (
      !verificationTracks[index] ||
      verificationTracks[index].expiresAt <= now
    ) {
      verificationTracks.splice(index, 1);
    }
  }
}

function rememberSuccessfulVerification(
  detection,
  verification,
  cropBuffer = null
) {
  if (
    !isPersonCandidate(detection) ||
    !verification ||
    verification.verifier_ok !== true ||
    verification.classification === 'uncertain'
  ) {
    return false;
  }

  const config = getPersonVerifierConfig();
  const now = Date.now();
  const cacheExpiresAt = now + config.cacheTtlMs;
  const trackExpiresAt = now + config.trackTtlMs;
  const key = verificationCacheKey(detection, cropBuffer);

  if (key) {
    verificationCache.set(
      key,
      Object.freeze({
        verification,
        expiresAt: cacheExpiresAt
      })
    );
  }

  verificationTracks.push(Object.freeze({
    bbox: normalizedBox(detection),
    verification,
    expiresAt: trackExpiresAt,
    yoloSupported: hasYoloSupport(detection)
  }));

  if (verificationTracks.length > 64) {
    verificationTracks.splice(
      0,
      verificationTracks.length - 64
    );
  }

  return true;
}

function findTrackedPersonVerification(detection) {
  if (!isPersonCandidate(detection)) return null;

  const config = getPersonVerifierConfig();
  const now = Date.now();

  pruneVerificationState(now);

  const area = boxArea(detection);
  let best = null;

  for (const track of verificationTracks) {
    const overlap = boxIou(track.bbox, detection);
    const distance = boxCenterDistance(track.bbox, detection);
    const trackArea = boxArea(track.bbox);
    const areaRatio =
      Math.max(area, trackArea) > 0
        ? Math.min(area, trackArea) /
          Math.max(area, trackArea)
        : 0;

    const spatialMatch =
      overlap >= config.trackIouThreshold ||
      (
        distance <= config.trackCenterDistance &&
        areaRatio >= 0.45
      );

    if (!spatialMatch) continue;

    if (
      track.verification.classification === 'live_person' &&
      !hasYoloSupport(detection) &&
      overlap < Math.max(0.55, config.trackIouThreshold)
    ) {
      continue;
    }

    const score =
      overlap * 10 +
      areaRatio -
      distance +
      Number(
        track.yoloSupported === hasYoloSupport(detection)
      );

    if (!best || score > best.score) {
      best = {
        track,
        score,
        overlap,
        distance
      };
    }
  }

  if (!best) return null;

  return Object.freeze({
    ...best.track.verification,
    cache_source: 'spatial_track',
    track_iou: Number(best.overlap.toFixed(4)),
    track_center_distance: Number(
      best.distance.toFixed(4)
    )
  });
}

function getCachedPersonVerification(detection) {
  pruneVerificationState();

  const key = verificationCacheKey(detection);

  if (key) {
    const cached = verificationCache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return Object.freeze({
        ...cached.verification,
        cache_source: 'visual_fingerprint'
      });
    }
  }

  return findTrackedPersonVerification(detection);
}

function attachCachedPersonVerifications(detectionFrame) {
  if (
    !detectionFrame ||
    !Array.isArray(detectionFrame.detections)
  ) {
    return detectionFrame;
  }

  let exactOrTrackHits = 0;

  const detections = detectionFrame.detections.map(
    (detection) => {
      if (!isPersonCandidate(detection)) {
        return detection;
      }

      if (
        detection.verification &&
        detection.verification.verifier_ok === true
      ) {
        return detection;
      }

      const verification =
        getCachedPersonVerification(detection);

      if (!verification) {
        return detection;
      }

      exactOrTrackHits += 1;

      return Object.freeze({
        ...detection,
        verification
      });
    }
  );

  return Object.freeze({
    ...detectionFrame,
    detections: Object.freeze(detections),
    person_verification: Object.freeze({
      enabled: getPersonVerifierConfig().enabled,
      cache_hits: exactOrTrackHits,
      attached_at: new Date().toISOString()
    })
  });
}

async function assertEndpointReady(
  endpoint,
  requiredModel,
  signal
) {
  const now = Date.now();

  if (
    endpointHealth.endpoint === endpoint &&
    endpointHealth.model === requiredModel &&
    now - endpointHealth.checkedAt < 10000
  ) {
    return;
  }

  const response = await fetch(endpoint + '/api/tags', {
    signal
  });

  if (!response.ok) {
    throw new Error(
      'person verifier model check returned HTTP ' +
      String(response.status)
    );
  }

  const body = await response.json();
  const models = Array.isArray(body.models)
    ? body.models
    : [];

  const visible = models.some((model) =>
    model && (
      model.name === requiredModel ||
      model.model === requiredModel
    )
  );

  if (!visible) {
    throw new Error(
      requiredModel +
      ' is not visible through the configured vision endpoint'
    );
  }

  endpointHealth = Object.freeze({
    checkedAt: now,
    endpoint,
    model: requiredModel
  });
}

async function callBatchVerifier(
  _fullFrameBuffer,
  candidates,
  options = {}
) {
  if (typeof options.verifier_runner === 'function') {
    return options.verifier_runner(_fullFrameBuffer, candidates);
  }

  const models = getModelConfig('chat');
  const config = getPersonVerifierConfig();
  const endpoint = String(
    models.vision.endpoint || ''
  ).replace(/\/+$/, '');

  if (!endpoint) {
    throw new Error('person verifier endpoint is empty');
  }

  const endpointTimeout = AbortSignal.timeout(
    Math.min(config.timeoutMs, 10000)
  );
  const endpointSignal = options.abort_signal
    ? AbortSignal.any([
        endpointTimeout,
        options.abort_signal
      ])
    : endpointTimeout;

  await assertEndpointReady(
    endpoint,
    models.vision.model,
    endpointSignal
  );

  const results = [];

  for (
    let candidateIndex = 0;
    candidateIndex < candidates.length;
    candidateIndex += 1
  ) {
    if (options.abort_signal && options.abort_signal.aborted) {
      throw new Error('person verifier aborted');
    }

    const candidate = candidates[candidateIndex];
    const schema = {
      type: 'object',
      properties: {
        candidate_index: {
          type: 'integer',
          enum: [candidateIndex]
        },
        classification: {
          type: 'string',
          enum: [
            'live_person',
            'depicted_person',
            'uncertain'
          ]
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1
        },
        depiction_type: {
          type: 'string',
          enum: [
            'none',
            'framed_photo',
            'poster',
            'screen',
            'artwork',
            'printed_image',
            'unknown'
          ]
        },
        short_basis: {
          type: 'string'
        }
      },
      required: [
        'candidate_index',
        'classification',
        'confidence',
        'depiction_type',
        'short_basis'
      ]
    };

    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = options.abort_signal
      ? AbortSignal.any([
          timeoutSignal,
          options.abort_signal
        ])
      : timeoutSignal;

    try {
      const response = await fetch(
        endpoint + '/api/generate',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: models.vision.model,
            prompt: [
              'This single image is a compressed crop taken directly from the current live webcam video frame.',
              `Return candidate_index ${candidateIndex}.`,
              'Judge only the dominant human-shaped subject inside this crop.',
              'live_person means a physically present three-dimensional human in the room.',
              'depicted_person means a human shown inside a framed photograph, poster, artwork, printed image, television, monitor, phone, or another flat display.',
              'Use uncertain when there is no human, the crop is ambiguous, or physical presence cannot be verified.',
              'Never infer from anything outside this crop, never guess, and return only the requested JSON object.'
            ].join(' '),
            images: [
              candidate.cropBuffer.toString('base64')
            ],
            format: schema,
            stream: false,
            // qwen vision models can spend the entire small token budget in
            // hidden reasoning and return an empty response. The verifier
            // needs one short JSON object, so thinking is disabled here.
            think: false,
            options: {
              temperature: 0,
              top_p: 0.1,
              num_predict: 256
            },
            keep_alive: models.vision.keep_alive
          }),
          signal
        }
      );

      if (!response.ok) {
        throw new Error(
          'person verifier endpoint returned HTTP ' +
          String(response.status)
        );
      }

      const body = await response.json();
      let parsed;

      try {
        parsed = JSON.parse(
          String(body.response || '').trim()
        );
      } catch (error) {
        throw new Error(
          'person verifier returned invalid JSON: ' +
          error.message
        );
      }

      results.push({
        ...parsed,
        candidate_index: candidateIndex
      });
    } catch (error) {
      if (options.abort_signal && options.abort_signal.aborted) {
        throw error;
      }

      results.push({
        candidate_index: candidateIndex,
        classification: 'uncertain',
        confidence: 0,
        depiction_type: 'unknown',
        short_basis: String(
          error && error.message
            ? error.message
            : error
        ).slice(0, 240)
      });
    }
  }

  return results;
}

async function verifyDetectionFramePersons(
  detectionFrame,
  framePath,
  options = {}
) {
  if (
    !detectionFrame ||
    !Array.isArray(detectionFrame.detections)
  ) {
    return detectionFrame;
  }

  const config = getPersonVerifierConfig();

  if (!config.enabled) {
    return Object.freeze({
      ...detectionFrame,
      detections: Object.freeze(
        detectionFrame.detections.map((detection) => {
          if (!isPersonCandidate(detection)) {
            return detection;
          }

          return Object.freeze({
            ...detection,
            verification: Object.freeze({
              candidate_index: -1,
              classification: 'uncertain',
              confidence: 0,
              depiction_type: 'unknown',
              short_basis:
                'person verifier disabled',
              verifier_ok: false
            })
          });
        })
      )
    });
  }

  const fullFrameBuffer =
    options.full_frame_buffer ||
    fs.readFileSync(framePath);
  const output = [...detectionFrame.detections];

  const groups = selectPersonCandidateGroups(output);
  const selectedIndexes = new Set(
    groups.flatMap((group) =>
      group.outputIndexes
    )
  );

  for (let index = 0; index < output.length; index += 1) {
    const detection = output[index];

    if (!isPersonCandidate(detection)) continue;

    const cached =
      getCachedPersonVerification(detection);

    if (cached) {
      output[index] = Object.freeze({
        ...detection,
        verification: cached
      });
      continue;
    }

    if (!selectedIndexes.has(index)) {
      output[index] = Object.freeze({
        ...detection,
        verification: Object.freeze({
          candidate_index: -1,
          classification: 'uncertain',
          confidence: 0,
          depiction_type: 'unknown',
          short_basis:
            'candidate did not meet strict verifier selection policy',
          verifier_ok: false
        })
      });
    }
  }

  const candidates = [];

  for (const group of groups) {
    const groupAlreadyVerified =
      group.outputIndexes.every((index) =>
        output[index] &&
        output[index].verification &&
        output[index].verification.verifier_ok === true
      );

    if (groupAlreadyVerified) continue;

    const cropBuffer = cropFrameBufferFromBuffer(
      fullFrameBuffer,
      group.detection,
      Number(detectionFrame.image_width),
      Number(detectionFrame.image_height),
      config.cropPaddingRatio
    );

    candidates.push({
      group,
      detection: group.detection,
      cropBuffer
    });
  }

  let verifierError = null;

  if (candidates.length > 0) {
    try {
      const rawResults = await callBatchVerifier(
        fullFrameBuffer,
        candidates,
        options
      );
      const byIndex = new Map();

      for (const raw of rawResults) {
        const normalized = normalizeVerificationResult(
          raw,
          config.minConfidence
        );

        byIndex.set(
          normalized.candidate_index,
          normalized
        );
      }

      for (
        let candidateIndex = 0;
        candidateIndex < candidates.length;
        candidateIndex += 1
      ) {
        const candidate = candidates[candidateIndex];
        const verification =
          byIndex.get(candidateIndex) ||
          Object.freeze({
            candidate_index: candidateIndex,
            classification: 'uncertain',
            confidence: 0,
            depiction_type: 'unknown',
            short_basis:
              'person verifier omitted this candidate',
            verifier_ok: false
          });

        for (
          const outputIndex of
          candidate.group.outputIndexes
        ) {
          const original = output[outputIndex];

          output[outputIndex] = Object.freeze({
            ...original,
            verification
          });

          if (verification.verifier_ok === true) {
            rememberSuccessfulVerification(
              original,
              verification,
              candidate.cropBuffer
            );
          }
        }

        if (verification.verifier_ok === true) {
          rememberSuccessfulVerification(
            candidate.detection,
            verification,
            candidate.cropBuffer
          );
        }
      }
    } catch (error) {
      verifierError = String(
        error && error.message
          ? error.message
          : error
      );

      for (
        let candidateIndex = 0;
        candidateIndex < candidates.length;
        candidateIndex += 1
      ) {
        const candidate = candidates[candidateIndex];

        for (
          const outputIndex of
          candidate.group.outputIndexes
        ) {
          output[outputIndex] = Object.freeze({
            ...output[outputIndex],
            verification: Object.freeze({
              candidate_index: candidateIndex,
              classification: 'uncertain',
              confidence: 0,
              depiction_type: 'unknown',
              short_basis:
                verifierError.slice(0, 240),
              verifier_ok: false
            })
          });
        }
      }
    }
  }

  return Object.freeze({
    ...detectionFrame,
    detections: Object.freeze(output),
    person_verification: Object.freeze({
      enabled: true,
      candidate_groups_total:
        buildPersonCandidateGroups(
          detectionFrame.detections
        ).length,
      candidate_groups_checked: candidates.length,
      verified_at: new Date().toISOString(),
      error: verifierError
    })
  });
}

function clearPersonVerificationCache() {
  verificationCache.clear();
  verificationTracks.splice(
    0,
    verificationTracks.length
  );
}

module.exports = {
  getPersonVerifierConfig,
  proposalSources,
  hasYoloSupport,
  hasGroundingDinoSupport,
  isPersonCandidate,
  normalizedBox,
  boxArea,
  boxIou,
  boxCenterDistance,
  buildPersonCandidateGroups,
  selectPersonCandidateGroups,
  paddedCrop,
  cropFrameBufferFromBuffer,
  verificationCacheKey,
  validateVerificationResult,
  normalizeVerificationResult,
  dinoOnlyObjectRequiresVerification,
  classifyVerifiedDetectionForDisplay,
  rememberSuccessfulVerification,
  getCachedPersonVerification,
  attachCachedPersonVerifications,
  callBatchVerifier,
  verifyDetectionFramePersons,
  clearPersonVerificationCache
};
