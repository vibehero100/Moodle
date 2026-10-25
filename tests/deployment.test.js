const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const install = read('scripts/install_moodle.sh');
const web = read('scripts/setup_webserver.sh');
const elastic = read('scripts/install_elastic.sh');
const bash = process.env.BASH || (process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');

function run(script, args = []) {
    return spawnSync(bash, args, { input: script, encoding: 'utf8', cwd: root });
}

test('Moodle 5.3 uses MySQL Flexible Server 8.4', () => {
    const template = JSON.parse(read('azuredeploy.json'));
    assert.deepEqual(template.parameters.mysqlVersion.allowedValues, ['8.4']);
    assert.equal(template.parameters.mysqlVersion.defaultValue, '8.4');
    assert.equal(template.parameters.moodleVersion.defaultValue, 'MOODLE_503_STABLE');
    const database = JSON.parse(read('nested/db-mysqlflex.json')).resources[0];
    assert.equal(database.apiVersion, '2024-12-30');
    assert.ok(database.properties.storage);
    assert.ok(database.properties.backup);
});

test('deployment shell scripts pass Bash syntax checks', () => {
    for (const file of ['scripts/install_moodle.sh', 'scripts/setup_webserver.sh',
        'scripts/helper_functions.sh', 'scripts/install_elastic.sh']) {
        const result = run(read(file), ['-n']);
        assert.equal(result.status, 0, result.stderr || String(result.error));
    }
});

test('controller and web setup failures propagate through tee', () => {
    for (const source of [install, web, elastic]) {
        const settings = source.match(/^set -exo pipefail$/m);
        assert.ok(settings);
        const result = run(`${settings[0]}\n{ false; echo UNEXPECTED; } 2>&1 | tee /dev/null\n`);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /UNEXPECTED/);
    }
    const commands = install.split('\n').filter(line =>
        line.includes('/admin/cli/install.php') || line.includes('/search/cli/indexer.php'));
    assert.equal(commands.length, 5);
    for (const command of commands) {
        assert.doesNotMatch(command, /\|\| true/);
    }
    assert.doesNotMatch(install, /azcopy .* \|\| true/);
});

test('generated downloader fails fast and installs plugins under public', () => {
    const generated = install.match(/cat <<EOF > \/tmp\/setup-moodle.sh\n([\s\S]*?)\nEOF/)[1];
    assert.match(generated, /^#!\/bin\/bash\nset -euo pipefail/);
    assert.match(generated, /archive\/\$moodleVersion\.zip/);
    const downloads = generated.split('\n').filter(line => line.includes('curl '));
    assert.equal(downloads.length, 9);
    for (const command of downloads) {
        assert.match(command, /--fail/);
    }
    const pluginCopies = generated.split('\n').filter(line =>
        /^\s*(\/bin\/mv|mv|cp) /.test(line) && !line.includes('"$moodleUnzipDir"'));
    assert.equal(pluginCopies.length, 8);
    for (const command of pluginCopies) {
        assert.match(command, /\/moodle\/html\/moodle\/public(?:\/|$)/);
    }
    const result = run(generated, ['-n']);
    assert.equal(result.status, 0, result.stderr);
});

test('shared and local copies serve public while retaining root config.php', () => {
    const block = web.slice(web.indexOf('  # Set up html dir local copy'),
        web.indexOf('  if [ "$httpsTermination" = "VMSS" ]; then', web.indexOf('  # Set up html dir local copy')))
        .replaceAll('/moodle/html/moodle', '${fixture}/shared')
        .replaceAll('/var/www/html', '${fixture}/local');
    for (const storage of ['azurefiles', 'nfs', 'nfs-ha', 'nfs-byo', 'gluster']) {
        for (const local of ['true', 'false']) {
            const result = run(`
set -eu
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/shared/public"
touch "$fixture/shared/public/index.php" "$fixture/shared/config.php"
fileServerType=${storage}
htmlLocalCopySwitch=${local}
storageAccountKey=test
storageAccountName=test
az() { echo test; }
azcopy() { mkdir -p "$htmlRootDir"; cp -a "$fixture/shared/." "$htmlRootDir/"; }
rsync() { cp -a "$fixture/shared/." "$htmlRootDir/"; }
chown() { :; }
sync() { :; }
setup_html_local_copy_cron_job() { :; }
${block}
test -f "$htmlRootDir/index.php"
test -f "$htmlRootDir/../config.php"
case "$htmlRootDir" in
  "$fixture/local/moodle/public") test "$htmlLocalCopySwitch" = true ;;
  "$fixture/shared/public") test "$htmlLocalCopySwitch" = false ;;
  *) exit 2 ;;
esac
`);
            assert.equal(result.status, 0, `${storage}/${local}: ${result.stderr}`);
        }
    }
});

test('incomplete web code copies fail rather than serving the source root', () => {
    const guard = web.slice(web.indexOf('  htmlRootDir="${htmlRootDir}/public"'),
        web.indexOf('  if [ "$httpsTermination" = "VMSS" ]; then', web.indexOf('  htmlRootDir="${htmlRootDir}/public"')));
    const result = run(`htmlRootDir=/nonexistent-moodle-test\n${guard}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to configure an incomplete site/);
});

test('web configuration supports Moodle routing and keeps CLI entry points', () => {
    assert.match(web, /try_files \\\$uri \\\$uri\/ \/r\.php\\\$is_args\\\$args;/);
    assert.match(web, /FallbackResource \/r\.php/);
    assert.match(install, /\/moodle\/html\/moodle\/admin\/cli\/cron\.php/);
    assert.match(install, /\/moodle\/html\/moodle\/public\/search\/cli\/indexer\.php/);
    assert.doesNotMatch(install, /ssl on;/);
});

test('Elasticsearch pins its service to Java 8 before restart', () => {
    assert.match(elastic, /apt_install_noninteractive openjdk-8-jre-headless/);
    assert.doesNotMatch(elastic, /apt_install_noninteractive .*default-j(?:re|dk)/);
    assert.match(elastic, /java-8-openjdk-\$\(dpkg --print-architecture\)/);
    assert.match(elastic, /if \[ ! -x "\$elasticJavaHome\/bin\/java" \]/);
    assert.match(elastic, /printf 'JAVA_HOME="%s"\\n' "\$elasticJavaHome" >> \/etc\/default\/elasticsearch/);
    assert.ok(elastic.indexOf('printf \'JAVA_HOME=') < elastic.indexOf('service elasticsearch restart'));
});

test('Elasticsearch readiness retries transient failures and rejects failed startup', () => {
    const block = elastic.slice(elastic.indexOf('  elasticReady=false'),
        elastic.indexOf('\n} 2>&1 | tee'));
    for (const scenario of ['ready', 'delayed', 'stopped', 'timeout']) {
        const result = run(`
set -e
calls=0
scenario=${scenario}
curl() {
  calls=$((calls + 1))
  case "$scenario" in
    ready) return 0 ;;
    delayed) test "$calls" -ge 3 ;;
    *) return 1 ;;
  esac
}
systemctl() { test "$scenario" != stopped; }
sleep() { :; }
journalctl() { echo SERVICE-DIAGNOSTICS; }
${block}
echo READY-AFTER-$calls
`);
        if (scenario === 'ready' || scenario === 'delayed') {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, scenario === 'ready' ? /READY-AFTER-1/ : /READY-AFTER-3/);
        } else {
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /failed to become responsive/);
            assert.match(result.stderr, /SERVICE-DIAGNOSTICS/);
            assert.doesNotMatch(result.stdout, /READY-AFTER/);
        }
    }
});
