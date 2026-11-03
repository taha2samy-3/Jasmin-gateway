import * as fs from 'fs';
import * as path from 'path';

export interface JasminConfigSection {
  [key: string]: string;
}

export interface JasminConfig {
  filePath: string;
  exists: boolean;
  sections: { [sectionName: string]: JasminConfigSection };
  rawMasked: string;
}

export class ConfigReader {
  private configPath: string;

  constructor(customPath?: string) {
    this.configPath = this.resolvePath(customPath);
  }

  private resolvePath(customPath?: string): string {
    const candidates = [
      customPath,
      process.env.JASMIN_CONFIG_PATH,
      '/etc/jasmin/jasmin.cfg',
      path.resolve(process.cwd(), '../docker/config/jasmin.cfg'),
      path.resolve(process.cwd(), 'docker/config/jasmin.cfg')
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return candidates[0] || '/etc/jasmin/jasmin.cfg';
  }

  public getConfig(): JasminConfig {
    if (!fs.existsSync(this.configPath)) {
      return {
        filePath: this.configPath,
        exists: false,
        sections: {},
        rawMasked: '# Configuration file not found at: ' + this.configPath
      };
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const sections = this.parseIni(content);
      const rawMasked = this.maskSensitiveData(content);

      return {
        filePath: this.configPath,
        exists: true,
        sections,
        rawMasked
      };
    } catch (err: any) {
      return {
        filePath: this.configPath,
        exists: false,
        sections: {},
        rawMasked: `# Error reading config file: ${err.message}`
      };
    }
  }

  private parseIni(content: string): { [sectionName: string]: JasminConfigSection } {
    const sections: { [sectionName: string]: JasminConfigSection } = {};
    let currentSection = 'default';

    const lines = content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let isComment = false;
      let effectiveLine = line;
      if (line.startsWith('#') || line.startsWith(';')) {
        isComment = true;
        effectiveLine = line.replace(/^[#;]+\s*/, '');
      }

      const sectionMatch = effectiveLine.match(/^\[(.*)\]$/);
      if (!isComment && sectionMatch) {
        currentSection = sectionMatch[1].trim();
        if (!sections[currentSection]) {
          sections[currentSection] = {};
        }
        continue;
      }

      const kvMatch = effectiveLine.match(/^([^=:#]+)[=:](.*)$/);
      if (kvMatch && currentSection !== 'default') {
        const key = kvMatch[1].trim();
        let value = kvMatch[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        if (!sections[currentSection]) {
          sections[currentSection] = {};
        }

        // Active lines have priority over commented defaults
        if (!isComment) {
          sections[currentSection][key] = value;
        } else if (sections[currentSection][key] === undefined) {
          sections[currentSection][key] = value;
        }
      }
    }

    return sections;
  }

  private maskSensitiveData(content: string): string {
    const sensitiveKeys = ['password', 'secret', 'admin_password', 'key', 'token'];
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
        return line;
      }
      for (const k of sensitiveKeys) {
        const regex = new RegExp(`^(\\s*${k}\\s*=\\s*)(.*)$`, 'i');
        if (regex.test(line)) {
          return line.replace(regex, '$1********');
        }
      }
      return line;
    }).join('\n');
  }
}
