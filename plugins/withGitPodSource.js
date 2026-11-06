const { withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// Prepend the git-based CocoaPods specs repo as a source alongside the CDN.
// EAS Build agents use only the CDN (cdn.cocoapods.org) which may not have
// newly published pod specs yet. Adding the authoritative git source ensures
// pod resolution succeeds even when the CDN cache is stale.
function withGitPodSource(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let content = fs.readFileSync(podfilePath, 'utf8');
      const gitSource = "source 'https://github.com/CocoaPods/Specs.git'";
      if (!content.includes(gitSource)) {
        content = gitSource + '\n' + content;
        fs.writeFileSync(podfilePath, content);
      }
      return config;
    },
  ]);
}

module.exports = withGitPodSource;
