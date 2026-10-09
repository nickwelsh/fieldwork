<?php

declare(strict_types=1);
use Example\UpdateProfileRequest;
use Fieldwork\Laravel\RequestExtractor;

require __DIR__.'/../../../packages/laravel/vendor/autoload.php';
require __DIR__.'/Enums/FormField.php';
require __DIR__.'/Enums/FormGroup.php';
require __DIR__.'/UpdateProfileRequest.php';

$request = new UpdateProfileRequest;
$extracted = (new RequestExtractor($request::fieldConfig()))->extract($request);
echo json_encode([
    'version' => 1,
    'forms' => [$extracted['form']],
    'diagnostics' => $extracted['diagnostics'],
], JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
