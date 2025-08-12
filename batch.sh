#!/bin/bash
NAMESPACE="kubexm-capture"
LABEL="app=tcpdump-capture"

echo "Fetching capture files from all nodes..."

NODES=$(kubectl get pods -n $NAMESPACE -l $LABEL -o jsonpath='{.items[*].spec.nodeName}')

for node in $NODES; do
  pod=$(kubectl get pods -n $NAMESPACE -l $LABEL --field-selector spec.nodeName=$node -o jsonpath='{.items[0].metadata.name}')
  if [ -n "$pod" ]; then
    echo "Copying from pod $pod on node $node..."
    kubectl cp ${NAMESPACE}/${pod}:/captures/${node}.pcap ./${node}.pcap
  else
    echo "No capture pod found on node $node."
  fi
done

echo "Done."