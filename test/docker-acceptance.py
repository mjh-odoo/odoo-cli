"""Local release acceptance. All mutations target a unique disposable project."""
import hashlib
import ipaddress
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

base = Path(sys.argv[1]).resolve()
cli = Path(sys.argv[2]).resolve()
project = Path(tempfile.mkdtemp(prefix='odoo-cli-acceptance-'))
network = project.name
checks = []
log = project / 'acceptance.log'

def run(args, input=None, ok=True):
    result = subprocess.run([str(x) for x in args], input=input, text=True, capture_output=True, cwd=project)
    with log.open('a') as out:
        out.write('$ ' + ' '.join(str(x) for x in args) + '\n' + result.stdout + result.stderr + '\n')
    if ok and result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(str(x) for x in args) + '\n' + result.stdout[-1500:] + result.stderr[-2500:])
    return result

def command(*args, **kwargs):
    return run([cli, '-C', project, *args], **kwargs)

def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    checks.append(name)
    print('PASS ' + name, flush=True)

env_before = (base / '.env').read_bytes()
containers_before = run(['docker', 'ps', '-q']).stdout.split()
network_created = False
values = {}
try:
    shutil.copyfile(base / '.env.example', project / '.env.example')
    (project / 'odoo').symlink_to(base / 'odoo', target_is_directory=True)
    (project / 'scripts').mkdir()
    shutil.copyfile(base / 'scripts/runtime.py', project / 'scripts/runtime.py')
    addons = project / 'addons/custom'
    addons.mkdir(parents=True)
    for name in ['cli_alpha', 'cli_beta']:
        folder = addons / name
        folder.mkdir()
        (folder / '__init__.py').write_text('')
        (folder / '__manifest__.py').write_text(repr({'name': name, 'version': '20.0.1.0.0', 'license': 'LGPL-3', 'depends': ['base'], 'installable': True}))
    compose = (base / 'compose.yaml').read_text()
    begin = compose.index('    build:\n')
    end = compose.index('    restart:', begin)
    compose = compose[:begin] + '    image: mjh-odoo/odoo-runtime:20.0-v0.1.0\n' + compose[end:]
    compose = compose.replace('./odoo:/opt/odoo/odoo:ro', str(base / 'odoo') + ':/opt/odoo/odoo:ro')
    compose = compose.replace('./addons:/opt/odoo/addons:ro', str(project / 'addons') + ':/opt/odoo/addons:ro')
    compose = compose.replace('./docker/postgres/initdb:/docker-entrypoint-initdb.d:ro', str(base / 'docker/postgres/initdb') + ':/docker-entrypoint-initdb.d:ro')
    compose += '\nnetworks:\n  default:\n    external: true\n    name: ' + network + '\n'
    (project / 'compose.yaml').write_text(compose)
    command('init', '--json')
    for line in (project / '.env').read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            values[k] = v
    identity = values['PROJECT_NAME']
    net_ids = run(['docker', 'network', 'ls', '-q']).stdout.split()
    networks = json.loads(run(['docker', 'network', 'inspect', *net_ids]).stdout)
    used = [ipaddress.ip_network(c['Subnet']) for n in networks for c in (n.get('IPAM', {}).get('Config') or []) if c.get('Subnet') and ':' not in c['Subnet']]
    subnet = next(ipaddress.ip_network(f'10.253.{i}.0/24') for i in range(240, 255) if not any(ipaddress.ip_network(f'10.253.{i}.0/24').overlaps(other) for other in used))
    run(['docker', 'network', 'create', '--internal', '--subnet', str(subnet), network])
    network_created = True
    command('up', '--no-build', '--pull', 'never')
    check('fresh project is healthy with prebuilt local image')
    command('doctor', '--json')
    command('module', 'install', 'cli_alpha', 'cli_beta')
    installed = json.loads(command('module', 'list', '--json').stdout)
    check('multiple modules install in one command', {'cli_alpha', 'cli_beta'} <= {row['name'] for row in installed})
    command('module', 'update', 'cli_alpha', 'cli_beta', '--no-restart')
    states = json.loads(command('status', '--json').stdout)
    check('multiple modules update and --no-restart leaves Odoo stopped', any(row['Service'] == 'odoo' and row['State'] == 'exited' for row in states))
    command('up', '--no-build', '--pull', 'never')
    command('exec', '--', 'shell', '-c', '/etc/odoo/odoo.conf', '--no-http', input="a=env['ir.attachment'].create({'name':'cli-acceptance.txt','raw':b'cli-archive-bytes','mimetype':'text/plain'}); env.cr.commit(); assert a.raw.content==b'cli-archive-bytes' and a.store_fname\n")
    archive = project / 'checkpoint.zip'
    command('db', 'backup', '--file', archive)
    with zipfile.ZipFile(archive) as z:
        check('backup is a standard ZIP with SQL, manifest and filestore', {'manifest.json', 'dump.sql'} <= set(z.namelist()) and any(name.startswith('filestore/') for name in z.namelist()))
    original = hashlib.sha256(archive.read_bytes()).hexdigest()
    refusal = command('db', 'backup', '--file', archive, ok=False)
    check('backup refuses to overwrite existing archives', refusal.returncode != 0 and hashlib.sha256(archive.read_bytes()).hexdigest() == original)
    command('db', 'restore', '--file', archive, '-d', 'restored_cli')
    databases = json.loads(command('db', 'list', '--json').stdout)
    check('restore creates an independent database without switching current configuration', any(x['name'] == 'restored_cli' and not x['current'] for x in databases) and any(x['name'] == values['PGDATABASE'] and x['current'] for x in databases))
    verify = command('exec', '--', 'shell', '-c', '/etc/odoo/odoo.conf', '-d', 'restored_cli', '--no-http', input="a=env['ir.attachment'].search([('name','=','cli-acceptance.txt')]); assert len(a)==1 and a.raw.content==b'cli-archive-bytes' and a.store_fname; print('ATTACHMENT_OK')\n")
    check('restored filestore returns the original attachment bytes', 'ATTACHMENT_OK' in verify.stdout)
    env_saved = (project / '.env').read_bytes()
    command('module', 'update', 'cli_alpha', 'cli_beta', '-d', 'restored_cli')
    check('module -d maintains the chosen database without editing .env', (project / '.env').read_bytes() == env_saved)
    logs = json.loads(command('logs', 'all', '--tail', '30', '--json').stdout)
    check('installed CLI returns structured real Docker log events', logs['project'] == identity and logs['scanned'] > 0)
    volumes = [identity + '_db-data', identity + '_odoo-data']
    command('down')
    run(['docker', 'volume', 'inspect', *volumes])
    check('normal down preserves both database and filestore volumes')
    command('up', '--no-build', '--pull', 'never')
    databases = json.loads(command('db', 'list', '--json').stdout)
    check('databases persist after down and up', any(x['name'] == 'restored_cli' for x in databases))
    command('down', '-v')
    for volume in volumes:
        check('explicit down -v removes only disposable volume ' + volume, run(['docker', 'volume', 'inspect', volume], ok=False).returncode != 0)
finally:
    if values:
        command('down', '-v', ok=False)
    if network_created:
        run(['docker', 'network', 'rm', network], ok=False)
    check('existing base .env was unchanged', (base / '.env').read_bytes() == env_before)
    after = set(run(['docker', 'ps', '-q']).stdout.split())
    check('previously running containers remain running', set(containers_before) <= after)
    (project / 'result.json').write_text(json.dumps({'project': str(project), 'checks': checks}, ensure_ascii=False, indent=2))
    print('EVIDENCE ' + str(project / 'result.json'), flush=True)
