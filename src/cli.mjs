import { Command, Option, InvalidArgumentError } from 'commander';
import { findProject, openProject, databaseName, runDocker, projectVersion } from './project.mjs';
import { readEnv } from './lib/environment.mjs';
import { parseLogOptions, executeLogs } from './lib/logs.mjs';
import { imageBuildPlan, executeImageBuild } from './lib/image.mjs';
import * as commands from './commands.mjs';

function integer(value) {
  if (!/^\d+$/.test(value) || +value > 3600) throw new InvalidArgumentError('请输入 0..3600 的整数。');
  return +value;
}
function positive(value) {
  const n = integer(value);
  if (!n) throw new InvalidArgumentError('等待时间必须大于 0。');
  return n;
}
function argumentsFor(options, names) {
  return names.flatMap(name => {
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = options[key];
    return value === true ? ['--' + name] : value === undefined || value === false ? [] : ['--' + name + '=' + String(value)];
  });
}

export function createProgram({version, cwd = process.cwd(), runner = runDocker} = {}) {
  const program = new Command();
  program.name('odoo').description('Odoo 项目开发管理：环境、模块、数据库、日志与镜像。').version(version, '-V, --version', '显示管理 CLI 版本')
    .option('-C, --project <directory>', '指定项目目录；默认从当前目录向上查找')
    .enablePositionalOptions().addHelpCommand('help [command...]', '查看命令帮助').showHelpAfterError('(运行 odoo --help 查看命令)').showSuggestionAfterError(true);
  program.addHelpText('after', '\n示例:\n  odoo up\n  odoo logs all --since 10m --json\n  odoo module update my_module\n  odoo db backup\n  odoo image build --help\n\n全局 --project 放在命令前，例如 odoo --project /path/to/erp status。');
  const root = () => findProject(program.opts().project || cwd);
  const context = initialize => openProject(root(), {initialize, runner});
  const waitOption = command => command.option('--wait-timeout <seconds>', '健康检查等待秒数', positive, 300);
  const databaseOption = command => command.option('-d, --database <name>', '目标数据库，默认 PGDATABASE', databaseName);

  program.command('version').description('显示管理 CLI 版本').action(() => console.log(version));
  program.command('init').description('为当前 base 项目准备本机 .env').option('--json', '输出脱敏 JSON').action(async options => commands.initialize(await context(true), options));
  program.command('doctor').description('检查 Docker、Compose、源码和配置').option('--json', '输出 JSON').action(async options => commands.doctor(await context(false), options));
  program.command('config').description('输出项目脱敏配置及存档位置').action(async () => commands.configuration(await context(false)));
  waitOption(program.command('up').description('后台启动项目并等待健康').option('--build', '构建开发镜像后启动（默认）', true).option('--no-build', '直接使用已有镜像，不构建')
    .addOption(new Option('--pull <policy>', '镜像拉取策略').choices(['always', 'missing', 'never'])))
    .action(async options => commands.up(await context(true), options));
  program.command('down').description('停止项目，默认保留数据库和附件卷')
    .option('-v, --volumes', '同时删除本项目数据库及附件卷').option('--timeout <seconds>', '停止等待秒数', integer, 30).option('--dry-run', '只显示操作计划，不执行停止或删除')
    .action(async options => commands.down(await context(false), options));
  waitOption(program.command('restart').description('重启服务，默认只重启 Odoo').argument('[services...]', 'odoo、db 或 all').option('--timeout <seconds>', '停止等待秒数', integer, 30))
    .action(async (services, options) => commands.restart(await context(false), services || [], options));
  program.command('status').description('查看项目容器状态，包含已停止容器').option('--json', '输出 JSON 数组').action(async options => commands.status(await context(false), options));
  program.command('build').description('构建项目 Compose 开发镜像').option('--pull', '更新上游镜像').option('--no-cache', '不使用构建缓存').action(async options => commands.build(await context(false), options));

  const logs = program.command('logs').description('默认读取最近 200 行快照；-f 才持续跟随').argument('[services...]', 'odoo、db 或 all，默认 odoo')
    .option('-f, --follow', '持续查看，Ctrl+C 只退出查看').option('-n, --tail <lines>', '每容器行数，支持 0 或 all', '200')
    .option('--since <time>', '起始时间，如 10m 或带时区 RFC3339').option('--until <time>', '截止时间')
    .option('--level <level>', '最低级别：debug/info/warning/error/critical').option('--match <text>', '不区分大小写的字面筛选')
    .option('--hide-health', '隐藏成功的 Odoo 健康检查').option('--context <events>', '筛选结果前后事件数，默认 2').option('--json', '输出完整 JSON 快照').option('--file <path>', '保存快照，拒绝覆盖已有文件');
  logs.addHelpText('after', '\n筛选、JSON 和文件用于有限快照，不能与 -f 同用。保留完整异常堆栈；--tail 起点仍可能截到异常中间。');
  logs.action(async (services, options) => {
    const parsed = parseLogOptions([...(services || []), ...argumentsFor(options, ['follow', 'tail', 'since', 'until', 'level', 'match', 'context', 'hide-health', 'json', 'file'])]);
    process.exitCode = await executeLogs(parsed, await context(false));
  });

  const module = program.command('module').description('查询、安装和升级模块');
  databaseOption(module.command('list').description('列出已安装模块').option('--all', '包含未安装模块').option('--json', '输出 JSON')).action(async options => commands.listModules(await context(false), options));
  for (const operation of ['install', 'update']) {
    const command = databaseOption(module.command(operation).description(operation === 'install' ? '批量安装模块' : '批量升级已安装模块')
      .argument(operation === 'install' ? '<modules...>' : '[modules...]', '用空格分隔多个模块名').option('--no-restart', '完成后保持 Odoo 停止'));
    if (operation === 'update') command.option('--all', '升级全部已安装的项目扩展（不包含官方核心）');
    command.action(async (names, options) => commands.maintainModules(await context(false), operation, names || [], options));
  }
  module.action(() => module.help());

  const db = program.command('db').description('数据库查询及标准 ZIP 备份恢复');
  db.command('list').description('列出项目 PostgreSQL 中的数据库').option('--json', '输出 JSON；current 表示当前配置的数据库').action(async options => commands.listDatabases(await context(false), options));
  databaseOption(db.command('backup').description('导出数据库及附件 ZIP').option('--file <path>', '输出路径；默认保存到工作树之外')).action(async options => commands.backup(await context(false), options));
  databaseOption(db.command('restore').description('恢复 ZIP，默认中和外发任务').requiredOption('--file <path>', '已有的 Odoo 20 ZIP')
    .option('--force', '允许覆盖已有目标数据库').option('--no-restart', '恢复后保持 Odoo 停止')).action(async options => commands.restore(await context(false), options));
  db.action(() => db.help());

  const image = program.command('image').description('构建基础镜像、项目镜像和离线包');
  image.command('build').description('默认构建本地基础镜像')
    .option('--platform <platforms>', 'amd64、arm64 或 amd64,arm64')
    .option('--tag <name:version>', '镜像标签；推送和 production 必填')
    .addOption(new Option('--target <stage>', '构建阶段').choices(['base', 'production']).default('base'))
    .option('--file <path.tar>', '导出单架构离线包').option('--push', '明确推送到镜像仓库').option('--builder <name>', '使用已有 Buildx 构建器').option('--dry-run', '仅输出 JSON 计划')
    .action(async options => {
      const directory = root();
      const plan = imageBuildPlan(argumentsFor(options, ['platform', 'tag', 'target', 'file', 'push', 'builder', 'dry-run']), {root: directory, version: projectVersion(directory), mirror: readEnv(directory).APT_MIRROR_BASE});
      if (plan.dryRun) { console.log(JSON.stringify(plan, null, 2)); return; }
      console.log(`构建 ${plan.target}: ${plan.tag} (${plan.platforms.join(',') || '当前构建器平台'})`);
      await executeImageBuild(plan, (argv, stdio) => runner(argv, {root: directory, env: process.env, stdio}));
      console.log(plan.file ? '离线包已保存: ' + plan.file : plan.output === 'registry' ? '镜像已推送: ' + plan.tag : '本地镜像就绪: ' + plan.tag);
    });
  image.action(() => image.help());

  program.command('exec').description('在运行中的 Odoo 容器里转发官方命令；本地说明用 help exec')
    .helpOption(false).allowUnknownOption(true).passThroughOptions().argument('[args...]', '原样传给官方 Odoo CLI 的参数')
    .addHelpText('after', '\n示例:\n  odoo exec -- --version\n  odoo exec -- --help\n  odoo exec -- shell -c /etc/odoo/odoo.conf')
    .action(async args => commands.native(await context(false), args || []));
  program.action(() => program.help());
  return program;
}
