import core from '@actions/core'
import { App, Octokit } from 'octokit'
import assert from 'assert'

import { Cache } from 'file-system-cache'
import { log } from 'console'
import createHash from 'crypto'
import { CachedOctokit } from './cached-octokit.js'

const privateKey = `-----BEGIN RSA PRIVATE KEY-----
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
-----END RSA PRIVATE KEY-----
`

// Alex classic token:
const token = 'xxx'

function hash(text) {
  var hash = createHash.createHash('sha256')
  hash.update(text)
  return hash.digest('hex')
}

export async function run() {
  try {
    const cache = new Cache({
      basePath: '.cache',
      ns: 'close-stale-repos',
      ttl: 3600 // 1 hour, to facilitate rapid iterations during development
    })

    const octokit = new CachedOctokit(cache, { auth: token, log: console })
    // GitHub Apps authentication:
    // const app = new App({ appId: 314387,  })
    // console.debug('app', app)
    // const { data: slug } = app.octokit.rest.apps.getAuthenticated()
    // console.debug('slug', slug)
    // const octokit = app.getInstallationOctokit(123)
    // console.debug('octokit', octokit)

    // const data = await octokit.request_cached('/user'); console.log('/user', data)

    const org_admins = await get_repository_admins(
      octokit,
      'SoftwareDefinedVehicle'
    )
    console.log(`Admins: ${admins.map(m => m.login).join(', ')}`)

    const stale_repos = await get_stale_repos(octokit, 'SoftwareDefinedVehicle')
    for (const repository of stale_repos) {
      console.log(`# ${repository.name}`)
      console.log(`_${repository.description}_`)
      console.log(``)
      console.log(`Last updated: ${repository.updatedAt}`)
      console.log(`Last pushed: ${repository.pushedAt}`)
      console.log(`Latest release: ${repository.latestRelease?.createdAt}`)
      console.log(`Last Commits:`)
      for (const commit of repository.defaultBranchRef?.target.history.nodes) {
        if (!commit.author.email.includes('noreply.github.com')) {
          console.log(
            `* ${commit.committedDate} - ${commit.author.name} <${commit.author.email}>`
          )
        } else {
          console.log(`* ${commit.committedDate} - ${commit.author.name}`)
        }
      }

      console.log('\n')
      console.log(`Collaborators (assigned directly by name):`)
      for (const collaborator of repository.collaborators.edges) {
        console.log(
          `* ${collaborator.node.name} <${collaborator.node.login}, ${collaborator.node.email}> - ${collaborator.permission}`
        )
      }
      console.log('\n')

      console.log('\n\n')
    }

    octokit.print_cache_stats()
  } catch (error) {
    // Fail the workflow run if an error occurs
    core.setFailed(error.message)
  }
}

async function get_repository_admins(octokit, org) {
  // Sanitize org name to avoid any kind of injection
  if (!org.match(/^[a-zA-Z0-9-]+$/)) {
    throw new Error(`Invalid org name: ${org}`)
  }

  try {
    // Note: In GraphQL API we can have it return only required fields, but there is no filtering in the request.
    //       Funny enough, the REST API has filtering!
    //       Typically a small amount of users are admins, so it seems better to use the REST API.
    const { data: members } = await octokit.request_cached(
      `GET /orgs/${org}/members`,
      {
        org: org,
        role: 'admin',
        per_page: 100
      }
    )
    assert(
      members.length < 100,
      'Pagination required, but not yet implemented!'
    )
    return members
  } catch (error) {
    console.error(`Error getting admins for ${org}: ${error.message}`)
    throw error
  }
}

function one_year_ago() {
  var one_year_ago = new Date()
  one_year_ago.setFullYear(one_year_ago.getFullYear() - 1)
  return one_year_ago.toISOString().substring(0, 10)
}

async function get_stale_repos(octokit, org) {
  const stale_date = one_year_ago()

  // Sanitize to avoid any kind of injection
  if (!org.match(/^[a-zA-Z0-9-]+$/)) {
    throw new Error(`Invalid org name: ${org}`)
  }

  if (!stale_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error(`Invalid stale date: ${stale_date}`)
  }

  const search_query = `org:${org} pushed:<${stale_date}`

  const graphql_query = `
  query stale_repos($search_query: String!, $limit: Int!) {
    search(
      query: $search_query
      type: REPOSITORY
      first: $limit
    ) {
      edges {
        node {
          ... on Repository {
            name
            description
            updatedAt
            pushedAt
            latestRelease {
              createdAt
            }
            isArchived
            isDisabled
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 15) {
                    nodes {
                      ... on Commit {
                        committedDate
                        author {
                          name
                          email
                        }
                      }
                    }
                  }
                }
              }
            }
            collaborators(affiliation: DIRECT) {
              edges {
                permissionSources {
                  roleName
                }
                permission
                node {
                  login
                  name
                  email
                }
              }
            }
          }
        }
      }
    }
  }
  `
  const graph = await octokit.graphql_cached(graphql_query, {
    search_query: search_query,
    limit: 15
  })
  const repositories = graph.search.edges.map(edge => edge.node)

  var stale_repos = []

  // iterate repositories
  for (const repository of repositories) {
    assert.strictEqual(
      repository.isArchived,
      false,
      `Repository ${repository.name} is archived`
    )
    assert.strictEqual(
      repository.isDisabled,
      false,
      `Repository ${repository.name} is disabled`
    )

    var stale_repo = {
      name: repository.name,
      description: repository.description,
      updatedAt: repository.updatedAt,
      pushedAt: repository.pushedAt,
      latestRelease: repository.latestRelease?.createdAt,
      lastCommitters: repository.defaultBranchRef?.target.history.nodes.map(
        commit => commit.author
      ),
      admins: []
    }
    for (const collaborator of repository.collaborators.edges) {
      stale_repo.admins.push({
        login: collaborator.node.login,
        name: collaborator.node.name,
        email: collaborator.node.email,
        permission: collaborator.permission
      })
    }
  }

  return stale_repos
}
