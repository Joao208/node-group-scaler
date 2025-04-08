import * as k8s from '@kubernetes/client-node'
import {
  EKSClient,
  DescribeNodegroupCommand,
  UpdateNodegroupConfigCommand,
} from '@aws-sdk/client-eks'
import { CronJob } from 'cron'

interface NodeGroupScalingPolicy {
  metadata: {
    namespace: string
    name: string
  }
  spec: {
    nodeGroup: {
      name: string
      provider: string
      region?: string
    }
    scaling: {
      minNodes: number
      maxNodes: number
    }
    schedule: Array<{
      cron: string
      targetNodes: number
      description?: string
    }>
    cooldownPeriod?: number
  }
}

interface K8sListResponse {
  items: NodeGroupScalingPolicy[]
}

const nodeGroupScalerCRD = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: {
    name: 'nodegroupscalingpolicies.scaling.nodegroupscaler.io',
  },
  spec: {
    group: 'scaling.nodegroupscaler.io',
    versions: [
      {
        name: 'v1alpha1',
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: 'object',
            properties: {
              spec: {
                type: 'object',
                properties: {
                  nodeGroup: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Name of the node group',
                      },
                      provider: {
                        type: 'string',
                        description: 'Cloud provider (e.g., aws)',
                        enum: ['aws'],
                      },
                      region: {
                        type: 'string',
                        description: 'Region where the node group is located',
                      },
                    },
                    required: ['name', 'provider'],
                  },
                  scaling: {
                    type: 'object',
                    properties: {
                      minNodes: {
                        type: 'integer',
                        description: 'Minimum number of nodes',
                      },
                      maxNodes: {
                        type: 'integer',
                        description: 'Maximum number of nodes',
                      },
                    },
                    required: ['minNodes', 'maxNodes'],
                  },
                  schedule: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        cron: {
                          type: 'string',
                          description: 'Cron expression for scheduling',
                        },
                        targetNodes: {
                          type: 'integer',
                          description:
                            'Target number of nodes for this schedule',
                        },
                        description: {
                          type: 'string',
                          description: 'Optional description of this schedule',
                        },
                      },
                      required: ['cron', 'targetNodes'],
                    },
                  },
                  cooldownPeriod: {
                    type: 'integer',
                    description:
                      'Cooldown period in seconds between scaling operations',
                  },
                },
                required: ['nodeGroup', 'scaling', 'schedule'],
              },
            },
          },
        },
      },
    ],
    scope: 'Namespaced',
    names: {
      plural: 'nodegroupscalingpolicies',
      singular: 'nodegroupscalingpolicy',
      kind: 'NodeGroupScalingPolicy',
      shortNames: ['ngsp'],
    },
  },
}

class NodeGroupScalerController {
  private k8sApi: k8s.CustomObjectsApi
  private eksClient: EKSClient
  private kc: k8s.KubeConfig
  private cronJobs: Map<string, CronJob>
  private lastScalingTime: Map<string, number>
  private logLevel: string
  private defaultCooldownPeriod: number
  private pollingInterval: number

  constructor(kc: k8s.KubeConfig) {
    this.kc = kc
    this.k8sApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.eksClient = new EKSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    })
    this.cronJobs = new Map()
    this.lastScalingTime = new Map()
    this.logLevel = process.env.LOG_LEVEL || 'info'
    this.defaultCooldownPeriod = parseInt(
      process.env.COOLDOWN_PERIOD || '300',
      10
    )
    this.pollingInterval =
      parseInt(process.env.POLLING_INTERVAL || '30', 10) * 1000 // Converte para milissegundos
  }

  private log(level: string, message: string) {
    const levels = ['error', 'warn', 'info', 'debug']
    const currentLevelIndex = levels.indexOf(this.logLevel)
    const messageLevelIndex = levels.indexOf(level)

    if (messageLevelIndex <= currentLevelIndex) {
      console.log(`[${level.toUpperCase()}] ${message}`)
    }
  }

  async start() {
    this.log('info', `Started polling every ${this.pollingInterval} seconds`)

    const poll = async () => {
      try {
        this.log('info', 'Listing policies...')

        const response = await this.k8sApi.listClusterCustomObject({
          group: 'scaling.nodegroupscaler.io',
          version: 'v1alpha1',
          plural: 'nodegroupscalingpolicies',
        })

        const { items: policies } = response as K8sListResponse

        this.log('info', `Found ${policies.length} policies`)

        const currentPolicies = new Set()

        for (const policy of policies) {
          this.log('info', `Processing policy ${policy.metadata.name}`)

          const { metadata } = policy
          const key = `${metadata.namespace}/${metadata.name}`
          currentPolicies.add(key)

          this.setupCronJobs(metadata.namespace, metadata.name, policy)
        }

        this.log('info', 'Removing old cron jobs...')

        for (const [jobKey] of this.cronJobs) {
          const policyKey = jobKey.split('-')[0]
          if (!currentPolicies.has(policyKey)) {
            this.removeCronJobs(policyKey)
            this.log('info', `Removed cron job for ${policyKey}`)
          }
        }

        this.log('info', 'Cron jobs updated')
      } catch (error) {
        this.log('error', `Polling error: ${error}`)
      }
    }

    await poll()
    setInterval(poll, this.pollingInterval)
  }

  private setupCronJobs(namespace: string, name: string, policy: any) {
    const key = `${namespace}/${name}`
    const { spec } = policy

    this.removeCronJobs(key)

    spec.schedule.forEach((scheduleItem: any) => {
      const job = new CronJob(scheduleItem.cron, () => {
        this.reconcileNodeGroupScaling(
          namespace,
          name,
          scheduleItem.targetNodes
        )
      })

      const jobKey = `${key}-${scheduleItem.cron}`
      this.cronJobs.set(jobKey, job)
      job.start()
      this.log(
        'info',
        `Cron job started for ${key} with schedule ${scheduleItem.cron}`
      )
    })
  }

  private removeCronJobs(key: string) {
    for (const [jobKey, job] of this.cronJobs.entries()) {
      if (jobKey.startsWith(key)) {
        job.stop()
        this.cronJobs.delete(jobKey)
        this.log('info', `Cron job stopped for ${jobKey}`)
      }
    }
  }

  private async reconcileNodeGroupScaling(
    namespace: string,
    name: string,
    targetNodes: number
  ) {
    try {
      const response = await this.k8sApi.getNamespacedCustomObject({
        group: 'scaling.nodegroupscaler.io',
        version: 'v1alpha1',
        namespace,
        plural: 'nodegroupscalingpolicies',
        name,
      })

      const policy = response.body
      const { spec } = policy
      const key = `${namespace}/${name}`

      const lastScaling = this.lastScalingTime.get(key) || 0
      const cooldownPeriod = spec.cooldownPeriod || this.defaultCooldownPeriod
      const now = Date.now()

      if (now - lastScaling < cooldownPeriod * 1000) {
        this.log('info', `Skipping scaling due to cooldown period for ${key}`)
        return
      }

      if (spec.nodeGroup.provider !== 'aws') {
        this.log(
          'info',
          `Provider ${spec.nodeGroup.provider} not supported yet`
        )
        return
      }

      const describeCommand = new DescribeNodegroupCommand({
        clusterName: spec.nodeGroup.name,
        nodegroupName: spec.nodeGroup.name,
      })

      const nodeGroupInfo = await this.eksClient.send(describeCommand)
      const currentNodeCount =
        nodeGroupInfo.nodegroup?.scalingConfig?.desiredSize || 0

      if (currentNodeCount === targetNodes) {
        this.log(
          'info',
          `Node group ${spec.nodeGroup.name} already at target size ${targetNodes}`
        )
        return
      }

      const boundedTargetNodes = Math.max(
        spec.scaling.minNodes,
        Math.min(spec.scaling.maxNodes, targetNodes)
      )

      const updateCommand = new UpdateNodegroupConfigCommand({
        clusterName: spec.nodeGroup.name,
        nodegroupName: spec.nodeGroup.name,
        scalingConfig: {
          desiredSize: boundedTargetNodes,
          minSize: spec.scaling.minNodes,
          maxSize: spec.scaling.maxNodes,
        },
      })

      await this.eksClient.send(updateCommand)
      this.lastScalingTime.set(key, now)

      this.log(
        'info',
        `Scaled node group ${spec.nodeGroup.name} to ${boundedTargetNodes} nodes`
      )
    } catch (error) {
      this.log(
        'error',
        `Error reconciling NodeGroupScalingPolicy ${namespace}/${name}: ${error}`
      )
    }
  }
}

export { NodeGroupScalerController, nodeGroupScalerCRD }
