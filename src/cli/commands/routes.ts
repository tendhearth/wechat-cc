import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { formatRetireCheck, readRouteUsage, retireCheck } from '../../lib/route-usage'

export const routesCmd = defineCommand({
  meta: { name: 'routes', description: 'Route compatibility retirement evidence (read only)' },
  subCommands: {
    'retire-check': defineCommand({
      meta: { name: 'retire-check', description: 'Check 30-day alias usage and active client versions; never deletes routes' },
      args: { json: { type: 'boolean', description: 'JSON evidence' } },
      run({ args }) {
        const result = retireCheck(readRouteUsage(STATE_DIR))
        console.log(args.json ? JSON.stringify(result, null, 2) : formatRetireCheck(result))
      },
    }),
  },
})
