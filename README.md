# Node Group Scaler Operator

A Kubernetes operator for managing automatic node group scaling based on various triggers and cloud providers.

## Overview

The Node Group Scaler Operator is a Kubernetes operator that automates the scaling of node groups across different cloud providers. It provides a flexible and powerful way to manage your cluster's infrastructure based on various triggers and conditions.

## Features

- Automatic node group scaling based on cron schedules
- Definition of minimum and maximum node limits
- Namespace-based configuration
- AWS EKS node group support (with plans to support other cloud providers)
- Flexible trigger system (currently supporting cron schedules, with plans to add more trigger types)
- Support for multiple scaling policies per node group
- Graceful scaling with configurable cooldown periods
- Detailed metrics and logging for scaling operations

## Installation

### Prerequisites

- Kubernetes cluster 1.19+
- Helm 3.0+
- AWS CLI configured (for AWS EKS support)
- kubectl configured to communicate with your cluster

### Using Helm

```bash
# Add the Helm repository
helm repo add node-group-scaler https://charts.nodegroupscaler.io
helm repo update

# Install the operator
helm install node-group-scaler node-group-scaler/node-group-scaler \
  --namespace node-group-scaler \
  --create-namespace
```

### Manual Installation

```bash
kubectl apply -f https://raw.githubusercontent.com/joao208/node-group-scaler/main/deploy/manifests.yaml
```

## Configuration

### NodeGroupScaler CRD

```yaml
apiVersion: scaling.nodegroupscaler.io/v1alpha1
kind: NodeGroupScalingPolicy
metadata:
  name: example-policy
  namespace: default
spec:
  nodeGroup:
    name: my-node-group
    provider: aws
    region: us-west-2
  scaling:
    minNodes: 2
    maxNodes: 10
  schedule:
    - cron: "0 9 * * 1-5" # Scale up at 9 AM on weekdays
      targetNodes: 8
    - cron: "0 18 * * 1-5" # Scale down at 6 PM on weekdays
      targetNodes: 2
  cooldownPeriod: 300 # 5 minutes between scaling operations
```

## Usage Examples

### Basic Scaling Policy

```yaml
apiVersion: scaling.nodegroupscaler.io/v1alpha1
kind: NodeGroupScalingPolicy
metadata:
  name: basic-scaling
spec:
  nodeGroup:
    name: production-nodes
    provider: aws
  scaling:
    minNodes: 3
    maxNodes: 15
  schedule:
    - cron: "0 8 * * *"
      targetNodes: 10
```

### Multiple Scaling Policies

```yaml
apiVersion: scaling.nodegroupscaler.io/v1alpha1
kind: NodeGroupScalingPolicy
metadata:
  name: complex-scaling
spec:
  nodeGroup:
    name: production-nodes
    provider: aws
  scaling:
    minNodes: 3
    maxNodes: 20
  schedule:
    - cron: "0 8 * * 1-5"
      targetNodes: 15
      description: "Weekday morning scale up"
    - cron: "0 18 * * 1-5"
      targetNodes: 5
      description: "Weekday evening scale down"
    - cron: "0 10 * * 0,6"
      targetNodes: 8
      description: "Weekend morning scale up"
```

## Monitoring and Logging

The operator provides detailed metrics and logs for all scaling operations:

- Detailed logs with scaling decisions
- Status updates in the NodeGroupScalingPolicy resource

## Troubleshooting

Common issues and their solutions:

1. **Scaling not occurring**

   - Check the operator logs
   - Verify cron schedule syntax
   - Ensure node group exists and is accessible

2. **Permission issues**

   - Verify IAM roles and permissions
   - Check service account configuration

3. **Scaling limits reached**
   - Review min/max node configurations
   - Check for any quota limitations

## Roadmap

- Support for additional cloud providers:
  - Google Cloud Platform (GKE)
  - Azure (AKS)
  - DigitalOcean
- Additional trigger types:
  - Metrics-based scaling (CPU, Memory, Custom metrics)
  - Event-based scaling
  - Time-based scaling with timezone support
  - Manual scaling triggers
- Enhanced features:
  - Cost optimization recommendations
  - Predictive scaling based on historical patterns
  - Multi-cluster support
  - Webhook integration for custom scaling logic

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on how to submit pull requests, report issues, and contribute to the project.

### Development Setup

1. Fork the repository
2. Clone your fork
3. Install dependencies:
   ```bash
   make setup
   ```

## Support

- GitHub Issues: [Report a bug](https://github.com/joao208/node-group-scaler/issues)
- Documentation: [Full documentation](https://docs.nodegroupscaler.io)
- Community: [Join our Slack channel](https://slack.nodegroupscaler.io)
