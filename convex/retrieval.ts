export const RRF_K = 60;

export function reciprocalRankFuse<T extends string>(
  rankings: readonly (readonly T[])[],
  limit: number,
) {
  const scores = new Map<T, number>();

  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
