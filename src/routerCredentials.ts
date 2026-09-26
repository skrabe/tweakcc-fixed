import { execFile } from 'node:child_process';

const SERVICE = 'tweakcc-fixed.typesafe';
const ACCOUNT = 'api-key';
const READ_TIMEOUT_MS = 1500;

type CredentialAction = 'read' | 'write' | 'delete';
type CredentialCommand = {
  executable: string;
  args: string[];
  input?: string;
};

function validKey(key: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(key);
}

function credentialCommand(
  action: CredentialAction,
  key?: string
): CredentialCommand {
  if (process.platform === 'darwin') {
    if (action === 'write') {
      const quoted = key!.replace(/[\\"]/g, '\\$&');
      return {
        executable: '/usr/bin/security',
        args: ['-i'],
        input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${quoted}"\n`,
      };
    }
    return {
      executable: '/usr/bin/security',
      args: [
        action === 'read' ? 'find-generic-password' : 'delete-generic-password',
        '-s',
        SERVICE,
        '-a',
        ACCOUNT,
        ...(action === 'read' ? ['-w'] : []),
      ],
    };
  }
  if (process.platform === 'linux') {
    return {
      executable: 'secret-tool',
      args: [
        action === 'read' ? 'lookup' : action === 'write' ? 'store' : 'clear',
        ...(action === 'write' ? ['--label=tweakcc TypeSafe API key'] : []),
        'service',
        SERVICE,
        'account',
        ACCOUNT,
      ],
      ...(action === 'write' ? { input: key } : {}),
    };
  }
  throw new Error(
    'Native credential storage is unavailable on this platform. Supply TYPESAFE_API_KEY through your environment or secret manager.'
  );
}

function runCredentialCommand(
  command: CredentialCommand,
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.executable,
      command.args,
      {
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 8192,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              'Could not access the OS credential store. Unlock your keychain, or install secret-tool and unlock Secret Service on Linux. Headless systems can supply TYPESAFE_API_KEY through a secret manager.'
            )
          );
        } else {
          resolve(stdout.trim());
        }
      }
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(command.input);
  });
}

export async function setRouterApiKey(key: string): Promise<void> {
  if (!validKey(key)) {
    throw new Error(
      'The API key must contain 1–1024 printable ASCII characters without spaces.'
    );
  }
  await runCredentialCommand(credentialCommand('write', key), 15000);
  const stored = await runCredentialCommand(credentialCommand('read'), 15000);
  if (stored !== key) {
    throw new Error(
      'The OS credential store did not retain the API key. Unlock your keychain and try again, or supply TYPESAFE_API_KEY through a secret manager.'
    );
  }
}

export async function deleteRouterApiKey(): Promise<void> {
  await runCredentialCommand(credentialCommand('delete'), 15000);
}

export async function hasRouterApiKey(): Promise<boolean> {
  const environmentKey = process.env.TYPESAFE_API_KEY;
  if (environmentKey) return validKey(environmentKey);
  try {
    return validKey(
      await runCredentialCommand(credentialCommand('read'), READ_TIMEOUT_MS)
    );
  } catch {
    return false;
  }
}

export function buildRouterCredentialRuntime(requireFunc: string): string {
  return `async function __tweakccRouterApiKey(){
    const valid=k=>typeof k==="string"&&/^[\\x21-\\x7e]{1,1024}$/.test(k);
    const env=process.env.TYPESAFE_API_KEY;
    if(env)return valid(env)?env:null;
    let command,args;
    if(process.platform==="darwin"){
      command="/usr/bin/security";
      args=["find-generic-password","-s",${JSON.stringify(SERVICE)},"-a",${JSON.stringify(ACCOUNT)},"-w"];
    }else if(process.platform==="linux"){
      command="secret-tool";
      args=["lookup","service",${JSON.stringify(SERVICE)},"account",${JSON.stringify(ACCOUNT)}];
    }else return null;
    try{
      return await new Promise(resolve=>{
        const child=${requireFunc}("node:child_process").execFile(command,args,{encoding:"utf8",timeout:${READ_TIMEOUT_MS},killSignal:"SIGKILL",maxBuffer:8192,windowsHide:true},(error,stdout)=>{
          const key=typeof stdout==="string"?stdout.trim():"";
          resolve(!error&&valid(key)?key:null);
        });
        child.stdin?.on("error",()=>{});
        child.stdin?.end();
      });
    }catch{return null;}
  }`;
}
