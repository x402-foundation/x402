import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { log, verboseLog, errorLog } from './logger';

export interface RunConfig {
  port?: number;
  env?: Record<string, string>;
  [key: string]: any;
}

export interface ProcessResult {
  success: boolean;
  data?: any;
  error?: string;
  exitCode?: number;
}

export abstract class BaseProxy {
  protected process: ChildProcess | null = null;
  protected directory: string;
  protected readyLog: string;
  protected resultLog?: string;

  constructor(directory: string, readyLog: string, resultLog?: string) {
    this.directory = directory;
    this.readyLog = readyLog;
    this.resultLog = resultLog;
  }

  protected getRunCommand(): string[] {
    const runShPath = join(this.directory, 'run.sh');

    if (!existsSync(runShPath)) {
      throw new Error(`run.sh not found in ${this.directory}`);
    }

    return ['bash', 'run.sh'];
  }

  protected async startProcess(config: RunConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getRunCommand();
      const env = {
        ...process.env,
        ...config.env
      };

      this.process = spawn(command[0], command.slice(1), {
        env,
        stdio: 'pipe',
        cwd: this.directory
      });

      let output = '';
      let stderr = '';
      let resolved = false;

      this.process.stdout?.on('data', (data) => {
        output += data.toString();
        verboseLog(`[${this.directory}] stdout: ${data.toString()}`);
        if (output.includes(this.readyLog) && !resolved) {
          resolved = true;
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        stderr += data.toString();
        verboseLog(`[${this.directory}] stderr: ${data.toString()}`);
      });

      this.process.on('error', (error) => {
        errorLog(`[${this.directory}] Error: ${error}`);
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      this.process.on('exit', (code) => {
        // If process exits during startup with non-zero code, reject
        if (code !== 0 && !resolved) {
          resolved = true;
          const errorMsg = `Process exited with code ${code} during startup`;
          errorLog(`[${this.directory}] ${errorMsg}`);
          reject(new Error(errorMsg));
        } else if (code !== 0) {
          // Already resolved, just log for debugging
          errorLog(`[${this.directory}] Process exited with code ${code}`);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.process && !this.process.killed && !resolved) {
          resolved = true;
          resolve();
        }
      }, 30000);
    });
  }

  protected async stopProcess(): Promise<void> {
    if (this.process) {
      return new Promise((resolve) => {
        const process = this.process!;
        process.kill('SIGTERM');

        // Force kill after 5 seconds
        const forceKillTimeout = setTimeout(() => {
          if (process && !process.killed) {
            process.kill('SIGKILL');
          }
        }, 5000);

        process.on('exit', () => {
          clearTimeout(forceKillTimeout);
          this.process = null;
          resolve();
        });

        // Fallback: if process doesn't exit within 10 seconds, resolve anyway
        setTimeout(() => {
          if (this.process) {
            this.process = null;
            resolve();
          }
        }, 10000);
      });
    }
  }

  protected async runOneShotProcess(config: RunConfig): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const command = this.getRunCommand();
      const processEnv = {
        ...process.env,
        ...config.env
      };

      const childProcess = spawn(command[0], command.slice(1), {
        env: processEnv,
        stdio: 'pipe',
        cwd: this.directory
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        verboseLog(`[${this.directory}] stdout: ${data.toString()}`);
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        verboseLog(`[${this.directory}] stderr: ${data.toString()}`);
      });

      childProcess.on('close', (code: number | null) => {
        // Try to find JSON in stdout regardless of exit code
        try {
          const lines = stdout.split('\n');
          const jsonLine = lines.find(line => line.trim().startsWith('{'));
          if (jsonLine) {
            const result = JSON.parse(jsonLine);
            if (code === 0) {
              resolve({ success: true, data: result, exitCode: code });
            } else {
              // Non-zero exit but we have JSON error details
              const errorMsg = result.error || `Process exited with code ${code}`;
              resolve({ success: false, error: errorMsg, exitCode: code || undefined });
            }
            return;
          }
        } catch (error) {
          // Failed to parse JSON, fall through to default error handling
        }

        // No JSON found or parse failed
        if (code === 0) {
          resolve({ success: false, error: 'No JSON result found', exitCode: code });
        } else {
          resolve({ success: false, error: stderr || `Process exited with code ${code}`, exitCode: code || undefined });
        }
      });

      childProcess.on('error', (error: Error) => {
        errorLog(`[${this.directory}] Process error: ${error.message}`);
        resolve({ success: false, error: error.message });
      });
    });
  }
}
