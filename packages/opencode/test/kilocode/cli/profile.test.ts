import { describe, expect, test } from "bun:test"

import { format, handle, payload } from "../../../src/kilocode/cli/cmd/profile"

describe("profile CLI formatting", () => {
  test("formats personal profile for human output", () => {
    expect(
      format({
        name: null,
        email: "one@example.com",
        team: "Personal",
        organizationId: null,
      }),
    ).toBe("Email: one@example.com\nTeam: Personal")
  })

  test("formats profile name for human output", () => {
    expect(
      format({
        name: "User One",
        email: "one@example.com",
        team: "Team One",
        organizationId: "org-1",
      }),
    ).toBe("Name: User One\nEmail: one@example.com\nTeam: Team One")
  })

  test("creates JSON payload", () => {
    expect(
      payload({
        profile: {
          name: "User One",
          email: "one@example.com",
          organizations: [{ id: "org-1", name: "Team One", role: "admin" }],
        },
        organizationId: "org-1",
      }),
    ).toEqual({
      name: "User One",
      email: "one@example.com",
      team: "Team One",
      organizationId: "org-1",
    })
  })

  test("writes human output to stdout", async () => {
    const logs: string[] = []
    const write = process.stdout.write

    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await handle({
        json: false,
        getAuth: async () => ({ type: "oauth", refresh: "refresh", access: "token", expires: 1 }),
        getProfile: async () => ({ email: "one@example.com", name: "User One" }),
      })
    } finally {
      process.stdout.write = write
    }

    expect(logs.join("")).toBe("Name: User One\nEmail: one@example.com\nTeam: Personal\n")
  })

  test("handles profile fetch errors without throwing", async () => {
    const errors: string[] = []
    const codes: number[] = []

    await handle({
      json: false,
      error: (msg) => errors.push(msg),
      exit: (code) => codes.push(code),
      getAuth: async () => ({ type: "oauth", refresh: "refresh", access: "token", expires: 1 }),
      getProfile: async () => {
        throw new Error("Invalid token")
      },
    })

    expect(errors).toEqual(["Invalid token"])
    expect(codes).toEqual([1])
  })
})
