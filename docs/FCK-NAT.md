# fck-nat Integration Guide

This infrastructure includes optional support for [fck-nat](https://github.com/AndrewGuenther/fck-nat), a cost-effective alternative to AWS NAT Gateway that can save you ~90% on NAT costs.

## Cost Comparison

| Solution           | Monthly Cost (2 AZs) | Data Processing | Annual Savings |
| ------------------ | -------------------- | --------------- | -------------- |
| AWS NAT Gateway    | ~$90/month           | $0.045/GB       | -              |
| fck-nat (t4g.nano) | ~$7.6/month          | $0/GB           | ~$988/year     |
| Savings            | ~ $82/month          | 100%            | ~ $988/year    |

## How fck-nat Works

fck-nat replaces AWS NAT Gateway with:

- EC2 instances running optimized NAT software
- ARM-based instances (t4g.nano/small) for best price/performance
- High availability with automatic failover
- CloudWatch integration for monitoring
- Source/destination check disabled for packet forwarding

## Using fck-nat in Your Infrastructure

### Enable fck-nat (Default for Cost Savings)

```bash
# Development environment (enabled by default)
cd environments/dev
pulumi config set useFckNat true
pulumi up
```

### Disable fck-nat (Use NAT Gateway)

```bash
# If you prefer traditional NAT Gateway
pulumi config set useFckNat false
pulumi up
```

### Configuration Options

```typescript
// In your environment configuration
const networking = new Networking(`${appName}-dev`, {
    name: appName,
    environment: "dev",
    cidrBlock: "10.0.0.0/24",
    availabilityZoneCount: 2,
    useFckNat: true, // Enable fck-nat for cost savings
});
```

## Architecture Details

### Traditional NAT Gateway Setup

```
Internet Gateway
       ↓
   Public Subnet
       ↓
   NAT Gateway ($45/month per AZ)
       ↓
  Private Subnet
```

### fck-nat Setup

```
Internet Gateway
       ↓
   Public Subnet
       ↓
   fck-nat Instance ($3.8/month per AZ)
       ↓
  Private Subnet
```

### High Availability

fck-nat provides HA through:

- Multiple instances: One per availability zone
- Auto-recovery: CloudWatch alarms trigger instance replacement
- Route table updates: Automatic routing updates on failover
- Health monitoring: Continuous health checks

## Monitoring fck-nat

### CloudWatch Metrics

The fck-nat instances automatically report:

- Instance health via EC2 status checks
- Network performance via CloudWatch metrics
- Cost tracking via resource tags

### Checking fck-nat Status

```bash
# Get fck-nat instance information
pulumi stack output natCostInfo

# Check instance health
aws ec2 describe-instance-status --instance-ids $(pulumi stack output --json | jq -r '.fckNatInstanceIds[]')

# Monitor network traffic
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name NetworkIn \
  --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
  --start-time $(date -d '1 hour ago' --iso-8601) \
  --end-time $(date --iso-8601) \
  --period 300 \
  --statistics Sum
```

## Security Considerations

### Security Groups

fck-nat instances use restrictive security groups:

```typescript
// Allows traffic only from private subnets
ingress: [{
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    cidrBlocks: ["10.0.0.0/16"], // Your VPC CIDR
    description: "Allow traffic from private subnets",
}],

// Allows all outbound traffic
egress: [{
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    cidrBlocks: ["0.0.0.0/0"],
    description: "Allow all outbound traffic",
}],
```

### IAM Permissions

fck-nat instances have minimal IAM permissions:

- EC2 route table management
- Network interface management
- CloudWatch metrics publishing

## Troubleshooting fck-nat

### Common Issues

#### 1. Instance Not Routing Traffic

```bash
# Check source/destination check is disabled
aws ec2 describe-instances --instance-ids i-1234567890abcdef0 \
  --query 'Reservations[].Instances[].SourceDestCheck'

# Should return: false
```

#### 2. High Latency or Packet Loss

```bash
# Check instance size - upgrade if needed
pulumi config set fckNatInstanceType t4g.small  # Upgrade from t4g.nano
pulumi up
```

#### 3. Instance Keeps Stopping

```bash
# Check CloudWatch logs
aws logs describe-log-streams \
  --log-group-name /aws/ec2/fck-nat \
  --order-by LastEventTime --descending

# Check instance metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
  --start-time $(date -d '1 hour ago' --iso-8601) \
  --end-time $(date --iso-8601) \
  --period 300 \
  --statistics Average,Maximum
```

### Performance Tuning

#### Instance Size Guidelines

| Traffic Level          | Recommended Instance | Monthly Cost |
| ---------------------- | -------------------- | ------------ |
| Light (<1 GB/day)      | t4g.nano             | ~$3.8/month  |
| Moderate (1-10 GB/day) | t4g.small            | ~$15/month   |
| Heavy (>10 GB/day)     | t4g.medium           | ~$30/month   |

#### Upgrade Instance Size

```bash
# In your environment configuration
cd environments/prod
pulumi config set fckNatInstanceType t4g.small
pulumi up
```

## Migration Guide

### From NAT Gateway to fck-nat

1. Update configuration:

    ```bash
    pulumi config set useFckNat true
    ```

2. Preview changes:

    ```bash
    pulumi preview
    # Review that NAT Gateway will be destroyed and fck-nat created
    ```

3. Deploy (with brief downtime):

    ```bash
    pulumi up
    # ~2-3 minutes downtime during migration
    ```

### From fck-nat to NAT Gateway

1. Update configuration:

    ```bash
    pulumi config set useFckNat false
    ```

2. Deploy:

    ```bash
    pulumi up
    # NAT Gateway will be created before fck-nat is destroyed
    ```

## Best Practices

### Development Environment

- Always use fck-nat — maximum cost savings
- t4g.nano instances — sufficient for dev workloads
- Single AZ if budget is extremely tight

### Staging Environment (lean)

- Use fck-nat — balance cost and reliability
- t4g.nano instances — sufficient for small teams and low traffic
- Single AZ to minimize cost (enable Multi-AZ only if explicitly testing HA)

### Production Environment

- Consider your requirements:
    - Use fck-nat if cost optimization is priority
    - Use NAT Gateway if maximum availability is critical
- t4g.small or larger — adequate performance
- Multi-AZ required — high availability

### Monitoring Setup

```typescript
// Add fck-nat monitoring to your dashboard
const fckNatMetrics = [
    ["AWS/EC2", "CPUUtilization", "InstanceId", fckNatInstanceId],
    ["AWS/EC2", "NetworkIn", "InstanceId", fckNatInstanceId],
    ["AWS/EC2", "NetworkOut", "InstanceId", fckNatInstanceId],
    ["AWS/EC2", "StatusCheckFailed", "InstanceId", fckNatInstanceId],
];
```

## Cost Tracking

### Check Your Savings

```bash
# Get cost information from stack outputs
pulumi stack output natCostInfo

# Example output:
# {
#   "type": "fck-nat",
#   "monthlyCost": 7.6,
#   "savings": 82.4
# }
```

### Cost Breakdown

| Component              | NAT Gateway | fck-nat | Savings |
| ---------------------- | ----------- | ------- | ------- |
| Hourly rate (per AZ)   | $0.045      | $0.0052 | 88%     |
| Data processing        | $0.045/GB   | $0/GB   | 100%    |
| Monthly (2 AZs, 100GB) | $94.50      | $7.60   | $86.90  |

## Considerations

### When to Use fck-nat

- Cost optimization is priority
- Predictable, moderate traffic
- Can tolerate brief downtime during failures
- Development and staging environments

### When to Use NAT Gateway

- Maximum availability required
- Very high traffic volumes (>10 Gbps)
- Strict compliance requirements
- Zero tolerance for any downtime

### Trade-offs

- Cost: fck-nat saves ~90% on NAT costs
- Availability: NAT Gateway has slightly higher SLA
- Performance: Comparable for most workloads
- Management: fck-nat requires monitoring EC2 instances

## Additional Resources

- [fck-nat GitHub Repository](https://github.com/AndrewGuenther/fck-nat)
- [AWS NAT Gateway Pricing](https://aws.amazon.com/vpc/pricing/)
- [EC2 Instance Pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
- [Cost Optimization Best Practices](./COST-OPTIMIZATION.md)

---

Recommendation: Start with fck-nat in development and staging environments to validate the setup, then consider production deployment based on your specific availability and cost requirements.
