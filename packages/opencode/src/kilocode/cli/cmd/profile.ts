import type { Argv } from "yargs"
import { cmd } from "../../../cli/cmd/cmd"
import { UI } from "../../../cli/ui"
import { Auth, type Info as AuthInfo } from "../../../auth"
import { makeRuntime } from "../../../effect/run-service"
import { fetchProfile, type KilocodeProfile } from "@kilocode/kilo-gateway"

const runtime = makeRuntime(Auth.Service, Auth.defaultLayer)

interface Info {
  name: string | null
  email: string
  team: string
  organizationId: string | null
}

export function payload(input: {
  profile: KilocodeProfile
  organizationId?: string | null
}): Info {
  const org = input.profile.organizations?.find((item) => item.id === input.organizationId)
  return {
    name: input.profile.name ?? null,
    email: input.profile.email,
    team: org?.name ?? "Personal",
    organizationId: input.organizationId ?? null,
  }
}

export function format(info: Info): string {
  const lines = [
    ...(info.name ? [`Name: ${info.name}`] : []),
    `Email: ${info.email}`,
    `Team: ${info.team}`,
  ]
  return lines.join("\n")
}

interface Args {
  json: boolean
  getAuth?: (providerID: string) => Promise<AuthInfo | undefined>
  getProfile?: (token: string) => Promise<KilocodeProfile>
  error?: (msg: string) => void
  exit?: (code: number) => void
}

export const ProfileCommand = cmd({
  command: "profile",
  describe: "show Kilo account profile",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "output profile as JSON",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    await handle({ json: args.json })
  },
})

export async function handle(args: Args) {
  const get = args.getAuth ?? ((id: string) => runtime.runPromise((svc) => svc.get(id)))
  const auth = await get("kilo")
  const error = args.error ?? UI.error
  const exit = args.exit ?? ((code: number) => (process.exitCode = code))

  if (!auth || auth.type !== "oauth") {
    error("Not authenticated with Kilo Gateway")
    exit(1)
    return
  }

  const org = auth.accountId ?? null
  const result = await (async () => {
    try {
      return await (args.getProfile ?? fetchProfile)(auth.access)
    } catch (err) {
      error(err instanceof Error ? err.message : String(err))
      exit(1)
      return undefined
    }
  })()
  if (!result) return

  const info = payload({ profile: result, organizationId: org })

  if (args.json) {
    console.log(JSON.stringify(info, null, 2))
    return
  }

  process.stdout.write(format(info) + "\n")
}
