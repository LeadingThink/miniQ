use super::*;

fn gemini(model: &str) -> OpenAiCompatProvider {
    let mut adapter = provider();
    adapter.config.model = model.into();
    adapter
}

fn completion(parameters: Value) -> CompletionRequest {
    let mut completion = request(None);
    completion.tools.push(ToolSpec {
        name: "channel_tool".into(),
        description: "Use the channel's declared parameter types".into(),
        parameters,
    });
    completion
}

#[test]
fn gemini_numeric_enums_keep_numeric_arguments_and_all_choices() {
    let parameters = json!({"type":"object", "properties":{
        "quality":{"type":"integer", "enum":[1,2,3], "default":1, "minimum":1,
            "description":"Channel quality level"},
        "enabled":{"type":"boolean", "enum":[true,false]},
        "mode":{"type":["string","null"], "enum":["auto",null], "default":null},
        "format":{"type":"string", "enum":["png","jpeg"]}
    }, "required":["quality"], "additionalProperties":false});
    let completion = completion(parameters.clone());
    for model in ["gemini-4-hydrogen", "google/Gemini-4-pro", "gemini-3.1-pro"] {
        let wire = gemini(model).build_body(&completion);
        let schema = &wire["tools"][0]["function"]["parameters"];
        let fields = &schema["properties"];
        assert_eq!(fields["quality"]["type"], "integer");
        assert_eq!(fields["quality"]["default"], 1);
        assert_eq!(fields["quality"]["minimum"], 1);
        for (name, choices) in [
            ("quality", "[1,2,3]"),
            ("enabled", "[true,false]"),
            ("mode", "[\"auto\",null]"),
        ] {
            assert!(fields[name].get("enum").is_none());
            assert!(fields[name]["description"]
                .as_str()
                .unwrap()
                .contains(choices));
        }
        assert!(fields["quality"]["description"]
            .as_str()
            .unwrap()
            .starts_with("Channel quality level\n"));
        assert_eq!(fields["enabled"]["type"], "boolean");
        assert_eq!(fields["mode"]["type"], json!(["string", "null"]));
        assert_eq!(fields["format"]["enum"], json!(["png", "jpeg"]));
        assert_eq!(schema["required"], json!(["quality"]));
        assert_eq!(schema["additionalProperties"], false);
    }
    assert_eq!(completion.tools[0].parameters, parameters);
}

#[test]
fn gemini_normalizes_schema_positions_without_rewriting_literal_data() {
    let literal = json!({"type":"string", "enum":[1], "properties":{"x":{"enum":[false]}}});
    let parameters = json!({"type":"object", "properties":{
        "rows":{"type":"array", "items":{"type":"object", "properties":{
            "enum":{"type":"integer", "const":1},
            "properties":{"type":"number", "enum":[0.5,1.0]}
        }}},
        "labels":{"type":"object", "additionalProperties":{"type":"boolean", "enum":[true]}},
        "choice":{"oneOf":[{"type":"integer","const":1},{"type":"integer","const":2}]},
        "payload":{"type":"object", "default":literal, "examples":[literal], "enum":[literal]}
    }, "$defs":{"level":{"type":"integer", "enum":[1,2]}}});
    let wire = gemini("gemini-4-hydrogen").build_body(&completion(parameters));
    let schema = &wire["tools"][0]["function"]["parameters"];
    for pointer in [
        "/properties/rows/items/properties/enum",
        "/properties/rows/items/properties/properties",
        "/properties/labels/additionalProperties",
        "/properties/choice",
        "/$defs/level",
    ] {
        let field = schema.pointer(pointer).unwrap();
        assert!(field.get("enum").is_none(), "{pointer}: {field}");
        assert!(field["description"]
            .as_str()
            .unwrap()
            .contains("Allowed values (JSON):"));
    }
    assert_eq!(schema["properties"]["payload"]["default"], literal);
    assert_eq!(
        schema["properties"]["payload"]["examples"],
        json!([literal])
    );
}

#[test]
fn gemini_rejects_contradictory_enums_with_tool_name_and_json_pointer() {
    for (schema, pointer) in [
        (
            json!({"type":"object","properties":{"a/b~c":{"type":"string","enum":[1]}}}),
            "/properties/a~1b~0c/enum/0",
        ),
        (
            json!({"type":"object","properties":{"rows":{"type":"array","items":{"type":"boolean","enum":["true"]}}}}),
            "/properties/rows/items/enum/0",
        ),
        (json!({"type":"integer","enum":[1.5]}), "/enum/0"),
        (json!({"type":"string","enum":[]}), "/enum"),
        (json!({"type":"string","enum":"auto"}), "/enum"),
    ] {
        let error = gemini("gemini-4-hydrogen")
            .try_build_body(&completion(schema))
            .unwrap_err();
        assert!(matches!(error, ProviderError::Config(_)));
        let message = error.to_string();
        assert!(message.contains("channel_tool"), "{message}");
        assert!(message.contains(pointer), "{message}");
    }
}

#[test]
fn gemini_accepts_integral_numbers_and_type_unions_without_stringifying_values() {
    let wire = gemini("gemini-4-hydrogen").build_body(&completion(json!({
        "type":"object", "properties":{
            "count":{"type":"integer","enum":[1.0,2]},
            "value":{"type":["string","integer","boolean","null"],"enum":["auto",1,true,null]}
        }
    })));
    let fields = &wire["tools"][0]["function"]["parameters"]["properties"];
    assert_eq!(fields["count"]["type"], "integer");
    assert!(fields["count"]["description"]
        .as_str()
        .unwrap()
        .contains("[1.0,2]"));
    assert!(fields["value"]["description"]
        .as_str()
        .unwrap()
        .contains("[\"auto\",1,true,null]"));
}

#[test]
fn non_gemini_models_keep_existing_json_schema_enum_encoding() {
    let parameters = json!({"type":"object","properties":{
        "quality":{"type":"integer","enum":[1,2]},
        "mode":{"type":["string","null"],"enum":["auto",null]}
    }});
    let wire = provider().build_body(&completion(parameters.clone()));
    assert_eq!(wire["tools"][0]["function"]["parameters"], parameters);
}
