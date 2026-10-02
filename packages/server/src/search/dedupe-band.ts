// The cosine thresholds behind the wiki "does this page already exist?" checks. Calibrated, not
// guessed: see the calibration section of the Wiki checks docs page, and the pre-registered study
// in the PR that introduced them. They are specific to BAAI/bge-m3 (the model they were measured
// on); a deployment on another embedding model should treat them as a starting point and pass
// `min_similarity` per call. The calibration could NOT reach precision >= 0.90 at a useful recall,
// so similarity is candidate evidence only: it never produces an "exists" verdict.

/** Topic string -> note (find_existing_page): the lowest best-chunk cosine reported as a possible match. */
export const TOPIC_MATCH_MIN = 0.708;

/** Note <-> note (lint_wiki, near-duplicate pass): the lowest note-vector cosine reported. */
export const NOTE_DUPLICATE_MIN = 0.909;

/** At or above this, a note pair is reported as near-identical rather than near-duplicate. Same
 *  ceiling the contradiction job uses to skip pairs that are effectively the same text. */
export const NOTE_IDENTICAL_MIN = 0.99;
