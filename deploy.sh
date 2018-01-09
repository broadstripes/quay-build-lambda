#!/usr/bin/env bash

set -exo pipefail

aws cloudformation package \
    --template template.yaml \
    --s3-bucket quay-build-lambda \
    --output-template-file cfn-package-output.yaml

aws cloudformation deploy \
    --stack-name QuayBuildLambda \
    --capabilities CAPABILITY_IAM \
    --template-file cfn-package-output.yaml \
    --parameter-overrides $(cat cfn-parameters)

rm cfn-package-output.yaml
