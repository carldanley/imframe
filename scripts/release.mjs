import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Docker tags cannot contain SemVer's optional "+build" suffix. The image also
// receives a separate SHA tag and revision label for identifying the build.
function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (prerelease?.split('.').some(part => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return null;
  return { version: value, major, minor, patch, prerelease };
}

function newerStable(candidate, current) {
  for (const component of ['major', 'minor', 'patch']) {
    const a = BigInt(candidate[component]);
    const b = BigInt(current[component]);
    if (a !== b) return a > b;
  }
  return false;
}

export function releaseMetadata({ version, lockVersion, lockPackageVersion, ref = '', tags = [] }) {
  const current = parseVersion(version);
  if (!current) throw new Error('Use a SemVer version such as 0.1.0 or 0.2.0-rc.1, without +build metadata.');
  if (lockVersion !== version || lockPackageVersion !== version) {
    throw new Error('package.json and package-lock.json versions differ. Use npm run version:bump to update both.');
  }
  const release = ref.startsWith('refs/tags/');
  if (release && ref !== `refs/tags/v${version}`) {
    throw new Error(`Release tag must be v${version} to match package.json.`);
  }
  const stableTags = tags.filter(tag => tag.startsWith('v')).map(tag => parseVersion(tag.slice(1)))
    .filter(tag => tag && !tag.prerelease);
  const newer = stableTags.filter(tag => newerStable(tag, current));
  const stable = release && !current.prerelease;
  return {
    version,
    release,
    minor: `${current.major}.${current.minor}`,
    major: current.major,
    publish_latest: stable && newer.length === 0,
    publish_minor: stable && !newer.some(tag => tag.major === current.major && tag.minor === current.minor),
    // Before 1.0, minor releases can break compatibility: never publish a "0" alias.
    publish_major: stable && current.major !== '0' && !newer.some(tag => tag.major === current.major),
  };
}

if (import.meta.main) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: npm run release:check -- [vX.Y.Z]');
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const ref = process.argv[2] ? `refs/tags/${process.argv[2]}` : process.env.GITHUB_REF ?? '';
    const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
    const metadata = releaseMetadata({
      version: manifest.version, lockVersion: lock.version, lockPackageVersion: lock.packages?.['']?.version,
      ref, tags,
    });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
    const aliases = [metadata.publish_minor && metadata.minor, metadata.publish_major && metadata.major, metadata.publish_latest && 'latest'].filter(Boolean);
    console.log(metadata.release
      ? `Release v${metadata.version}: ${[metadata.version, ...aliases, 'sha-…'].join(', ')}`
      : `Version ${metadata.version} is consistent. An untagged manual build publishes only sha-….`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
