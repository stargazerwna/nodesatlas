const RELEASES_URL = 'https://api.github.com/repos/stargazerwna/nodesatlas/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/stargazerwna/nodesatlas/releases/tag/';

function parseVersion(value) {
  return typeof value === 'string' ? /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim()) : null;
}

export function getAvailableRelease(release, currentVersion) {
  const latest = parseVersion(release?.tag_name);
  const current = parseVersion(currentVersion);
  if (!latest || !current || latest[4] || release.draft || release.prerelease) return null;
  let newer = Boolean(current[4]);
  for (let index = 1; index <= 3; index++) {
    if (BigInt(latest[index]) !== BigInt(current[index])) {
      newer = BigInt(latest[index]) > BigInt(current[index]);
      break;
    }
  }
  if (!newer || typeof release.html_url !== 'string' || !release.html_url.startsWith(RELEASE_PAGE_PREFIX)) return null;
  return { version: latest.slice(1, 4).join('.'), url: release.html_url };
}

export async function checkForRelease(currentVersion, fetchRelease = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchRelease(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return getAvailableRelease(await response.json(), currentVersion);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
