import * as k8s from "@kubernetes/client-node";
import {
  EKSClient,
  DescribeNodegroupCommand,
  UpdateNodegroupConfigCommand,
} from "@aws-sdk/client-eks";
import { CronJob } from "cron";

const nodeGroupScalerCRD = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: {
    name: "nodegroupscalingpolicies.scaling.nodegroupscaler.io",
  },
  spec: {
    group: "scaling.nodegroupscaler.io",
    versions: [
      {
        name: "v1alpha1",
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              spec: {
                type: "object",
                properties: {
                  nodeGroup: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Name of the node group",
                      },
                      provider: {
                        type: "string",
                        description: "Cloud provider (e.g., aws)",
                        enum: ["aws"],
                      },
                      region: {
                        type: "string",
                        description: "Region where the node group is located",
                      },
                    },
                    required: ["name", "provider"],
                  },
                  scaling: {
                    type: "object",
                    properties: {
                      minNodes: {
                        type: "integer",
                        description: "Minimum number of nodes",
                      },
                      maxNodes: {
                        type: "integer",
                        description: "Maximum number of nodes",
                      },
                    },
                    required: ["minNodes", "maxNodes"],
                  },
                  schedule: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        cron: {
                          type: "string",
                          description: "Cron expression for scheduling",
                        },
                        targetNodes: {
                          type: "integer",
                          description:
                            "Target number of nodes for this schedule",
                        },
                        description: {
                          type: "string",
                          description: "Optional description of this schedule",
                        },
                      },
                      required: ["cron", "targetNodes"],
                    },
                  },
                  cooldownPeriod: {
                    type: "integer",
                    description:
                      "Cooldown period in seconds between scaling operations",
                  },
                },
                required: ["nodeGroup", "scaling", "schedule"],
              },
            },
          },
        },
      },
    ],
    scope: "Namespaced",
    names: {
      plural: "nodegroupscalingpolicies",
      singular: "nodegroupscalingpolicy",
      kind: "NodeGroupScalingPolicy",
      shortNames: ["ngsp"],
    },
  },
};

class NodeGroupScalerController {
  private k8sApi: k8s.CustomObjectsApi;
  private eksClient: EKSClient;
  private kc: k8s.KubeConfig;
  private cronJobs: Map<string, CronJob>;
  private lastScalingTime: Map<string, number>;

  constructor(kc: k8s.KubeConfig) {
    this.kc = kc;
    this.k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.eksClient = new EKSClient({});
    this.cronJobs = new Map();
    this.lastScalingTime = new Map();
  }

  async start() {
    console.log("NodeGroupScaler Controller started");

    try {
      const watch = new k8s.Watch(this.kc);

      const stream = await watch.watch(
        "/apis/scaling.nodegroupscaler.io/v1alpha1/nodegroupscalingpolicies",
        {},
        (type, obj) => {
          const policy = obj;
          const { metadata } = policy;
          const key = `${metadata.namespace}/${metadata.name}`;

          console.log(
            `Received ${type} event for NodeGroupScalingPolicy ${key}`
          );

          switch (type) {
            case "ADDED":
            case "MODIFIED":
              this.setupCronJobs(metadata.namespace, metadata.name, obj);
              break;
            case "DELETED":
              this.removeCronJobs(key);
              console.log(`NodeGroupScalingPolicy ${key} was deleted`);
              break;
          }
        },
        (err) => {
          console.error("Watch error:", err);
          stream.abort();
          setTimeout(() => this.start(), 5000);
        }
      );
    } catch (error) {
      console.error("Error starting watch:", error);
      setTimeout(() => this.start(), 5000);
    }
  }

  private setupCronJobs(namespace: string, name: string, policy: any) {
    const key = `${namespace}/${name}`;
    const { spec } = policy;

    this.removeCronJobs(key);

    spec.schedule.forEach((scheduleItem: any) => {
      const job = new CronJob(scheduleItem.cron, () => {
        this.reconcileNodeGroupScaling(
          namespace,
          name,
          scheduleItem.targetNodes
        );
      });

      const jobKey = `${key}-${scheduleItem.cron}`;
      this.cronJobs.set(jobKey, job);
      job.start();
      console.log(
        `Cron job started for ${key} with schedule ${scheduleItem.cron}`
      );
    });
  }

  private removeCronJobs(key: string) {
    for (const [jobKey, job] of this.cronJobs.entries()) {
      if (jobKey.startsWith(key)) {
        job.stop();
        this.cronJobs.delete(jobKey);
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
        group: "scaling.nodegroupscaler.io",
        version: "v1alpha1",
        namespace,
        plural: "nodegroupscalingpolicies",
        name,
      });

      const policy = response.body;
      const { spec } = policy;
      const key = `${namespace}/${name}`;

      // Check cooldown period
      const lastScaling = this.lastScalingTime.get(key) || 0;
      const cooldownPeriod = spec.cooldownPeriod || 300; // Default 5 minutes
      const now = Date.now();

      if (now - lastScaling < cooldownPeriod * 1000) {
        console.log(`Skipping scaling due to cooldown period for ${key}`);
        return;
      }

      if (spec.nodeGroup.provider !== "aws") {
        console.log(`Provider ${spec.nodeGroup.provider} not supported yet`);
        return;
      }

      const describeCommand = new DescribeNodegroupCommand({
        clusterName: spec.nodeGroup.name,
        nodegroupName: spec.nodeGroup.name,
      });

      const nodeGroupInfo = await this.eksClient.send(describeCommand);
      const currentNodeCount =
        nodeGroupInfo.nodegroup?.scalingConfig?.desiredSize || 0;

      if (currentNodeCount === targetNodes) {
        console.log(
          `Node group ${spec.nodeGroup.name} already at target size ${targetNodes}`
        );
        return;
      }

      // Ensure target nodes is within min/max bounds
      const boundedTargetNodes = Math.max(
        spec.scaling.minNodes,
        Math.min(spec.scaling.maxNodes, targetNodes)
      );

      const updateCommand = new UpdateNodegroupConfigCommand({
        clusterName: spec.nodeGroup.name,
        nodegroupName: spec.nodeGroup.name,
        scalingConfig: {
          desiredSize: boundedTargetNodes,
          minSize: spec.scaling.minNodes,
          maxSize: spec.scaling.maxNodes,
        },
      });

      await this.eksClient.send(updateCommand);
      this.lastScalingTime.set(key, now);

      console.log(
        `Scaled node group ${spec.nodeGroup.name} to ${boundedTargetNodes} nodes`
      );
    } catch (error) {
      console.error(
        `Error reconciling NodeGroupScalingPolicy ${namespace}/${name}:`,
        error
      );
    }
  }
}

export { NodeGroupScalerController, nodeGroupScalerCRD };
