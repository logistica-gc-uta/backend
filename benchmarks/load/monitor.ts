import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

/** Una lectura de recursos tomada durante la corrida. Todo en la misma máquina (laptop de pruebas). */
export interface ResourceSample {
  /** Milisegundos desde epoch. */
  t: number;
  apiCpuPct: number;
  apiRssMb: number;
  dbCpuPct: number;
  dbMemMb: number;
  dbConnections: number;
}

export interface ResourceSummary {
  samples: number;
  apiCpuAvg: number;
  apiCpuMax: number;
  apiRssMaxMb: number;
  dbCpuAvg: number;
  dbCpuMax: number;
  dbMemMaxMb: number;
  dbConnectionsMax: number;
}

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);
const max = (values: number[]) => (values.length ? Math.max(...values) : Number.NaN);

export function summarizeResources(samples: readonly ResourceSample[]): ResourceSummary {
  return {
    samples: samples.length,
    apiCpuAvg: avg(samples.map((s) => s.apiCpuPct)),
    apiCpuMax: max(samples.map((s) => s.apiCpuPct)),
    apiRssMaxMb: max(samples.map((s) => s.apiRssMb)),
    dbCpuAvg: avg(samples.map((s) => s.dbCpuPct)),
    dbCpuMax: max(samples.map((s) => s.dbCpuPct)),
    dbMemMaxMb: max(samples.map((s) => s.dbMemMb)),
    dbConnectionsMax: max(samples.map((s) => s.dbConnections)),
  };
}

/** "123.4MiB", "1.5GiB", "800kB" → megabytes. */
export function parseMemoryMb(text: string): number {
  const match = /^\s*([\d.]+)\s*([KMGT]?i?B)\s*$/i.exec(text);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const factor: Record<string, number> = { B: 1 / 1048576, KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024, TB: 1048576, TIB: 1048576 };
  return value * (factor[unit] ?? Number.NaN);
}

/** Una línea JSON de `docker stats --no-stream --format "{{json .}}"`. */
export function parseDockerStats(line: string): { cpuPct: number; memMb: number } {
  const data = JSON.parse(line) as { CPUPerc?: string; MemUsage?: string };
  const cpuPct = Number((data.CPUPerc ?? '').replace('%', ''));
  const memMb = parseMemoryMb((data.MemUsage ?? '').split('/')[0] ?? '');
  if (!Number.isFinite(cpuPct) || !Number.isFinite(memMb)) throw new Error('Salida de docker stats no reconocida');
  return { cpuPct, memMb };
}

/** CPU % de un proceso entre dos lecturas de su tiempo de CPU (segundos), normalizado al total de núcleos. */
export function cpuPercent(cpuSecondsBefore: number, cpuSecondsAfter: number, wallSeconds: number, cores: number): number {
  if (wallSeconds <= 0 || cores <= 0) return 0;
  return Math.max(0, ((cpuSecondsAfter - cpuSecondsBefore) / wallSeconds / cores) * 100);
}

/** Lectura de /proc/<pid>/stat y status en Linux (utime+stime en ticks, RSS en kB). */
export function readLinuxProcess(pid: number): { cpuSeconds: number; rssMb: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]); // utime, stime
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return { cpuSeconds: ticks / 100, rssMb: rssKb / 1024 };
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
  );

/**
 * Muestrea la API (proceso), el contenedor de PostgreSQL y sus conexiones cada `intervalMs`.
 * En Windows se usa un único PowerShell de larga vida (lanzar uno por lectura distorsionaría la medición).
 */
export function startMonitor(options: { apiPid: number; dbContainer: string; dbName: string; dbUser: string; intervalMs?: number }) {
  const intervalMs = options.intervalMs ?? 2000;
  const cores = os.cpus().length;
  const samples: ResourceSample[] = [];
  let latestApi = { cpuPct: 0, rssMb: 0 };
  let latestDb = { cpuPct: 0, memMb: 0 };
  let latestConnections = 0;
  let stopped = false;
  let powershell: ChildProcess | undefined;

  if (process.platform === 'win32') {
    const script = `$p=${options.apiPid};$prev=$null;$prevT=$null;while($true){try{$x=Get-Process -Id $p -ErrorAction Stop;$t=[DateTime]::UtcNow;$c=$x.TotalProcessorTime.TotalSeconds;if($prev -ne $null){$cpu=($c-$prev)/(($t-$prevT).TotalSeconds)/${cores}*100}else{$cpu=0};$prev=$c;$prevT=$t;Write-Output ("{0:F2},{1:F1}" -f $cpu,($x.WorkingSet64/1MB))}catch{Write-Output "0,0"};Start-Sleep -Milliseconds ${intervalMs}}`;
    powershell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    powershell.stdout!.setEncoding('utf8');
    powershell.stdout!.on('data', (chunk: string) => {
      const last = chunk.trim().split(/\r?\n/).pop() ?? '';
      const [cpu, rss] = last.split(',').map(Number);
      if (Number.isFinite(cpu) && Number.isFinite(rss)) latestApi = { cpuPct: cpu!, rssMb: rss! };
    });
  }

  let linuxPrev: { cpuSeconds: number; at: number } | undefined;
  const sampleApiLinux = () => {
    try {
      const now = Date.now();
      const reading = readLinuxProcess(options.apiPid);
      if (linuxPrev) latestApi = { cpuPct: cpuPercent(linuxPrev.cpuSeconds, reading.cpuSeconds, (now - linuxPrev.at) / 1000, cores), rssMb: reading.rssMb };
      linuxPrev = { cpuSeconds: reading.cpuSeconds, at: now };
    } catch {
      latestApi = { cpuPct: 0, rssMb: 0 };
    }
  };

  const loop = async () => {
    while (!stopped) {
      const started = Date.now();
      if (process.platform !== 'win32') sampleApiLinux();
      try {
        latestDb = parseDockerStats(await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', options.dbContainer]));
        latestConnections = Number(
          await run('docker', ['exec', options.dbContainer, 'psql', '-U', options.dbUser, '-d', options.dbName, '-Atc',
            `select count(*) from pg_stat_activity where datname='${options.dbName}'`]),
        );
      } catch {
        // una lectura fallida no detiene la corrida: se repite la última
      }
      samples.push({
        t: Date.now(), apiCpuPct: latestApi.cpuPct, apiRssMb: latestApi.rssMb,
        dbCpuPct: latestDb.cpuPct, dbMemMb: latestDb.memMb, dbConnections: latestConnections,
      });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))));
    }
  };
  const done = loop();

  return {
    samples,
    /** Lectura más reciente, para decidir si se aborta por límites seguros. */
    latest: () => samples[samples.length - 1],
    stop: async () => {
      stopped = true;
      powershell?.kill();
      await done;
    },
  };
}
