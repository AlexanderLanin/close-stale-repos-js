import * as core from '@actions/core'
import { App, Octokit } from 'octokit'
import assert from 'assert'

import { Cache } from 'file-system-cache'
import { log } from 'console'

export class CachedOctokit extends Octokit {
  constructor(cache, octokit_options) {
    super(octokit_options)
    this.cache = cache
    this.extra_cache_keys = JSON.stringify(octokit_options || [])

    this.hits = 0
    this.misses = 0
  }

  async graphql_cached(query, parameters, retention_in_seconds = 3600) {
    const cache_key = JSON.stringify({
      query,
      parameters,
      extra_cache_keys: this.extra_cache_keys
    })

    const cached_data = await this.cache.get(cache_key)
    if (cached_data) {
      this.hits += 1

      return cached_data
    } else {
      this.misses += 1

      // we need to await the result to ensure that the cache is populated
      const live_data = await this.graphql(query, parameters)
      this.cache.set(cache_key, live_data, retention_in_seconds)
      return live_data
    }
  }

  async request_cached(route, options, retention_in_seconds = 3600) {
    const cache_key = JSON.stringify({
      route,
      options,
      extra_cache_keys: this.extra_cache_keys
    })

    const cached_data = await this.cache.get(cache_key)
    if (cached_data) {
      this.hits += 1
      console.debug(`cache hit: ${route} ${JSON.stringify(options)}`)
      return cached_data
    } else {
      this.misses += 1

      // we need to await the result to ensure that the cache is populated
      const live_data = await this.request(route, options)
      await this.cache.set(cache_key, live_data, retention_in_seconds)
      return live_data
    }
  }

  print_cache_stats() {
    console.log()
    console.log('cache stats:')
    console.log('  hits:', this.hits)
    console.log('  misses:', this.misses)
    console.log(
      '  hit rate:',
      (this.hits / (this.hits + this.misses)) * 100,
      '%'
    )
  }
}
