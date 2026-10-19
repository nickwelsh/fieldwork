<?php

declare(strict_types=1);

return [
    'requests' => ['app/Http/Requests'],
    'enums' => [
        'fields' => 'App\\Enums\\FormField',
        'components' => 'App\\Enums\\FormComponent',
        'groups' => 'App\\Enums\\FormGroup',
    ],
    'profiles' => [],
    'fields' => [
        // Replace these strings with your generated App\Enums\FormField cases.
        'types' => [
            'string' => 'TextField',
            'integer' => 'NumberField',
            'number' => 'NumberField',
            'boolean' => 'CheckboxField',
            'date' => 'DateField',
            'enum' => 'SelectField',
            'file' => 'FileField',
        ],
        'rules' => [
            'email' => ['component' => 'TextField', 'props' => ['type' => 'email']],
            'url' => ['component' => 'TextField', 'props' => ['type' => 'url']],
        ],
        // Used only when no rule establishes a value type.
        'fallbackType' => 'string',
    ],
];
