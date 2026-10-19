<?php

declare(strict_types=1);
use Example\Enums\FormComponent;
use Example\Enums\FormField;
use Example\Enums\FormGroup;

return [
    'enums' => [
        'fields' => FormField::class,
        'components' => FormComponent::class,
        'groups' => FormGroup::class,
    ],
];
