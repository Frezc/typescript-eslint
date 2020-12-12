import { TSESTree, AST_NODE_TYPES } from '@typescript-eslint/types';
import { Referencer } from './Referencer';
import { Visitor } from './Visitor';
import { ParameterDefinition, TypeDefinition } from '../definition';
import { ScopeType } from '../scope';

class TypeVisitor extends Visitor {
  readonly #referencer: Referencer;

  constructor(referencer: Referencer) {
    super(referencer);
    this.#referencer = referencer;
  }

  static visit(referencer: Referencer, node: TSESTree.Node): void {
    const typeReferencer = new TypeVisitor(referencer);
    typeReferencer.visit(node);
  }

  static visitAndCheckEmit(
    referencer: Referencer,
    node: TSESTree.TSTypeAnnotation,
    withDecorators?: boolean,
  ): void {
    const typeReferencer = new TypeVisitor(referencer);
    typeReferencer.visitAndCheckDecoratorMetadata(node, withDecorators);
  }

  ///////////////////
  // Visit helpers //
  ///////////////////

  protected visitFunctionType(
    node:
      | TSESTree.TSCallSignatureDeclaration
      | TSESTree.TSConstructorType
      | TSESTree.TSConstructSignatureDeclaration
      | TSESTree.TSFunctionType
      | TSESTree.TSMethodSignature,
  ): void {
    // arguments and type parameters can only be referenced from within the function
    this.#referencer.scopeManager.nestFunctionTypeScope(node);
    this.visit(node.typeParameters);

    for (const param of node.params) {
      let didVisitAnnotation = false;
      this.visitPattern(param, (pattern, info) => {
        // a parameter name creates a value type variable which can be referenced later via typeof arg
        this.#referencer
          .currentScope()
          .defineIdentifier(
            pattern,
            new ParameterDefinition(pattern, node, info.rest),
          );

        if (pattern.typeAnnotation) {
          this.visit(pattern.typeAnnotation);
          didVisitAnnotation = true;
        }
      });

      // there are a few special cases where the type annotation is owned by the parameter, not the pattern
      if (!didVisitAnnotation && 'typeAnnotation' in param) {
        this.visit(param.typeAnnotation);
      }
    }
    this.visit(node.returnType);

    this.#referencer.close(node);
  }

  protected visitPropertyKey(
    node: TSESTree.TSMethodSignature | TSESTree.TSPropertySignature,
  ): void {
    if (!node.computed) {
      return;
    }
    // computed members are treated as value references, and TS expects they have a literal type
    this.#referencer.visit(node.key);
  }

  /**
   * check type is referenced by decorator metadata
   */
  protected visitAndCheckDecoratorMetadata(
    node: TSESTree.TSTypeAnnotation,
    withDecorators?: boolean,
  ): void {
    // emit decorators metadata only work for TSTypeReference
    if (
      node.typeAnnotation.type === AST_NODE_TYPES.TSTypeReference &&
      this.#referencer.emitDecoratorMetadata
    ) {
      let identifier: TSESTree.Identifier;
      if (
        node.typeAnnotation.typeName.type === AST_NODE_TYPES.TSQualifiedName
      ) {
        let iter = node.typeAnnotation.typeName;
        while (iter.left.type === AST_NODE_TYPES.TSQualifiedName) {
          iter = iter.left;
        }
        identifier = iter.left;
      } else {
        identifier = node.typeAnnotation.typeName;
      }
      const scope = this.#referencer.currentScope();
      /**
       * class A {
       *   @meta     // <--- check this
       *   foo: Type;
       * }
       */
      if (scope.type === ScopeType.class && withDecorators) {
        return this.#referencer
          .currentScope()
          .referenceDualValueType(identifier);
      }

      const methodNode = this.#referencer.currentMethodNode();
      // in method
      if (scope.upper?.type === ScopeType.class && methodNode) {
        /**
         * class A {
         *   @meta     // <--- check this
         *   foo(a: Type) {}
         *
         *   @meta     // <--- check this
         *   foo(): Type {}
         * }
         */
        if (methodNode.decorators) {
          return this.#referencer
            .currentScope()
            .referenceDualValueType(identifier);
        }

        /**
         * class A {
         *   foo(
         *     @meta    // <--- check this
         *     a: Type
         *   ) {}
         *
         *   set foo(
         *     @meta    // <--- EXCEPT this. TS do nothing for this
         *     a: Type
         *   ) {}
         * }
         */
        if (withDecorators && methodNode.kind !== 'set') {
          return this.#referencer
            .currentScope()
            .referenceDualValueType(identifier);
        }

        if (methodNode.kind === 'set') {
          const keyName = getLiteralMethodKeyName(methodNode);
          const classNode = scope.upper.block;

          /**
           * class A {
           *   @meta      // <--- check this
           *   get a() {}
           *   set ['a'](v: Type) {}
           * }
           */
          if (
            keyName !== null &&
            classNode.body.body.find(
              (node): node is TSESTree.MethodDefinition =>
                node !== methodNode &&
                node.type === AST_NODE_TYPES.MethodDefinition &&
                // Node must both be static or not
                node.static === methodNode.static &&
                getLiteralMethodKeyName(node) === keyName,
            )?.decorators
          ) {
            return this.#referencer
              .currentScope()
              .referenceDualValueType(identifier);
          }
        }

        /**
         * @meta      // <--- check this
         * class A {
         *   constructor(a: Type) {}
         * }
         */
        if (
          methodNode.kind === 'constructor' &&
          scope.upper.block.type === AST_NODE_TYPES.ClassDeclaration &&
          scope.upper.block.decorators
        ) {
          return this.#referencer
            .currentScope()
            .referenceDualValueType(identifier);
        }
      }
    }
    this.visit(node);
  }

  /////////////////////
  // Visit selectors //
  /////////////////////

  protected Identifier(node: TSESTree.Identifier): void {
    this.#referencer.currentScope().referenceType(node);
  }

  protected MemberExpression(node: TSESTree.MemberExpression): void {
    this.visit(node.object);
    // don't visit the property
  }

  protected TSCallSignatureDeclaration(
    node: TSESTree.TSCallSignatureDeclaration,
  ): void {
    this.visitFunctionType(node);
  }

  protected TSConditionalType(node: TSESTree.TSConditionalType): void {
    // conditional types can define inferred type parameters
    // which are only accessible from inside the conditional parameter
    this.#referencer.scopeManager.nestConditionalTypeScope(node);

    // type parameters inferred in the condition clause are not accessible within the false branch
    this.visitChildren(node, ['falseType']);

    this.#referencer.close(node);

    this.visit(node.falseType);
  }

  protected TSConstructorType(node: TSESTree.TSConstructorType): void {
    this.visitFunctionType(node);
  }

  protected TSConstructSignatureDeclaration(
    node: TSESTree.TSConstructSignatureDeclaration,
  ): void {
    this.visitFunctionType(node);
  }

  protected TSFunctionType(node: TSESTree.TSFunctionType): void {
    this.visitFunctionType(node);
  }

  protected TSIndexSignature(node: TSESTree.TSIndexSignature): void {
    for (const param of node.parameters) {
      if (param.type === AST_NODE_TYPES.Identifier) {
        this.visit(param.typeAnnotation);
      }
    }
    this.visit(node.typeAnnotation);
  }

  protected TSInferType(node: TSESTree.TSInferType): void {
    const typeParameter = node.typeParameter;
    let scope = this.#referencer.currentScope();

    /*
    In cases where there is a sub-type scope created within a conditional type, then the generic should be defined in the
    conditional type's scope, not the child type scope.
    If we define it within the child type's scope then it won't be able to be referenced outside the child type
    */
    if (
      scope.type === ScopeType.functionType ||
      scope.type === ScopeType.mappedType
    ) {
      // search up the scope tree to figure out if we're in a nested type scope
      let currentScope = scope.upper;
      while (currentScope) {
        if (
          currentScope.type === ScopeType.functionType ||
          currentScope.type === ScopeType.mappedType
        ) {
          // ensure valid type parents only
          currentScope = currentScope.upper;
          continue;
        }
        if (currentScope.type === ScopeType.conditionalType) {
          scope = currentScope;
          break;
        }
        break;
      }
    }

    scope.defineIdentifier(
      typeParameter.name,
      new TypeDefinition(typeParameter.name, typeParameter),
    );
  }

  protected TSInterfaceDeclaration(
    node: TSESTree.TSInterfaceDeclaration,
  ): void {
    this.#referencer
      .currentScope()
      .defineIdentifier(node.id, new TypeDefinition(node.id, node));

    if (node.typeParameters) {
      // type parameters cannot be referenced from outside their current scope
      this.#referencer.scopeManager.nestTypeScope(node);
      this.visit(node.typeParameters);
    }

    node.extends?.forEach(this.visit, this);
    node.implements?.forEach(this.visit, this);
    this.visit(node.body);

    if (node.typeParameters) {
      this.#referencer.close(node);
    }
  }

  protected TSMappedType(node: TSESTree.TSMappedType): void {
    // mapped types key can only be referenced within their return value
    this.#referencer.scopeManager.nestMappedTypeScope(node);
    this.visitChildren(node);
    this.#referencer.close(node);
  }

  protected TSMethodSignature(node: TSESTree.TSMethodSignature): void {
    this.visitPropertyKey(node);
    this.visitFunctionType(node);
  }

  protected TSNamedTupleMember(node: TSESTree.TSNamedTupleMember): void {
    this.visit(node.elementType);
    // we don't visit the label as the label only exists for the purposes of documentation
  }

  protected TSPropertySignature(node: TSESTree.TSPropertySignature): void {
    this.visitPropertyKey(node);
    this.visit(node.typeAnnotation);
  }

  protected TSQualifiedName(node: TSESTree.TSQualifiedName): void {
    this.visit(node.left);
    // we don't visit the right as it a name on the thing, not a name to reference
  }

  protected TSTypeAliasDeclaration(
    node: TSESTree.TSTypeAliasDeclaration,
  ): void {
    this.#referencer
      .currentScope()
      .defineIdentifier(node.id, new TypeDefinition(node.id, node));

    if (node.typeParameters) {
      // type parameters cannot be referenced from outside their current scope
      this.#referencer.scopeManager.nestTypeScope(node);
      this.visit(node.typeParameters);
    }

    this.visit(node.typeAnnotation);

    if (node.typeParameters) {
      this.#referencer.close(node);
    }
  }

  protected TSTypeParameter(node: TSESTree.TSTypeParameter): void {
    this.#referencer
      .currentScope()
      .defineIdentifier(node.name, new TypeDefinition(node.name, node));

    this.visit(node.constraint);
    this.visit(node.default);
  }

  protected TSTypePredicate(node: TSESTree.TSTypePredicate): void {
    if (node.parameterName.type !== AST_NODE_TYPES.TSThisType) {
      this.#referencer.currentScope().referenceValue(node.parameterName);
    }
    this.visit(node.typeAnnotation);
  }

  // a type query `typeof foo` is a special case that references a _non-type_ variable,
  protected TSTypeQuery(node: TSESTree.TSTypeQuery): void {
    if (node.exprName.type === AST_NODE_TYPES.Identifier) {
      this.#referencer.currentScope().referenceValue(node.exprName);
    } else {
      let expr = node.exprName.left;
      while (expr.type !== AST_NODE_TYPES.Identifier) {
        expr = expr.left;
      }
      this.#referencer.currentScope().referenceValue(expr);
    }
  }

  protected TSTypeAnnotation(node: TSESTree.TSTypeAnnotation): void {
    // check
    this.visitChildren(node);
  }
}

/**
 * Only if key is one of [identifier, string, number], ts will combine metadata of accessors .
 * class A {
 *   get a() {}
 *   set ['a'](v: Type) {}
 *
 *   get [1]() {}
 *   set [1](v: Type) {}
 *
 *   // Following won't be combined
 *   get [key]() {}
 *   set [key](v: Type) {}
 *
 *   get [true]() {}
 *   set [true](v: Type) {}
 *
 *   get ['a'+'b']() {}
 *   set ['a'+'b']() {}
 * }
 */
function getLiteralMethodKeyName(
  node: TSESTree.MethodDefinition,
): string | number | null {
  if (node.computed && node.key.type === AST_NODE_TYPES.Literal) {
    if (
      typeof node.key.value === 'string' ||
      typeof node.key.value === 'number'
    ) {
      return node.key.value;
    }
  } else if (!node.computed && node.key.type === AST_NODE_TYPES.Identifier) {
    return node.key.name;
  }
  return null;
}

export { TypeVisitor };
